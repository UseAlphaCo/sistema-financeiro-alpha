import { randomUUID } from "node:crypto";

import { logError, logInfo } from "../../core/observability/logger";

import { getWorkerEnv, type WorkerEnv } from "./config";
import { createCorePool, createOmsPool } from "./db";
import { partitionByMirrorFloor } from "./mirror-floor";
import { sweepByPageCursor } from "./page-cursor-sync";
import { CoreRepository } from "./repositories/core-repository";
import { OmsRepository } from "./repositories/oms-repository";
import type { SyncControlStore, WorkerSummary } from "./types";
import { mapPayloadToRawPayloadRecord, validateSyncEvent } from "./validation";

const WORKER_LOCK_KEY = 9382201;

/** Unico stream hoje: raw_payloads do OMS -> mirror do CORE. */
export const SYNC_STREAM = "oms_raw_payloads";

/**
 * Como o ciclo descobre o que precisa entrar na fila.
 *
 * - "ctid": varredura por cursor fisico de pagina (cauda + auditoria). E o
 *   padrao do ciclo automatico desde 2026-08-18, e o unico modo que funciona
 *   sem indice no OMS. Ver page-cursor-sync.ts.
 * - "incremental": avanca por keyset a partir da marca d'agua. Depende de um
 *   indice por (received_at, processed_at) que o OMS nao tem, entao estoura o
 *   statement_timeout. Mantido so como rollback.
 * - "none": nao descobre nada, apenas drena a fila.
 *
 * O modo "window" foi removido em 2026-08-24. Varria uma janela de N dias com
 * a mesma dependencia de indice, era disparavel por um clique em /integracoes,
 * e a query morria no query_timeout deixando o job preso em `running` -- o que
 * fazia o cron seguinte nao fazer nada por ate 15 min, sem registrar nada.
 * Reparo por janela de datas agora e scripts/backfill-mirror-window.ts.
 */
type SyncDiscovery = { mode: "incremental" } | { mode: "ctid" } | { mode: "none" };

type RunSyncOptions = {
  discovery?: SyncDiscovery;
  /** Quem disparou o ciclo, para o heartbeat: 'cron' | 'manual' | 'script'. */
  triggerSource?: string;
};

type DiscoveryResult = { candidates: number; missing: number; queued: number };

/**
 * Descoberta incremental por marca d'agua: le do OMS so o que entrou depois
 * do ultimo ponto lido e enfileira o que ainda nao esta no mirror.
 *
 * Antes, o ciclo automatico varria uma janela de 30 dias a cada execucao
 * (288 vezes por dia com o cron de 5 em 5 minutos) e sempre sobre as mesmas
 * ~200 linhas mais recentes. Aqui o custo e proporcional ao que chegou de
 * novo.
 */
async function discoverIncremental(
  cycleId: string,
  omsRepository: OmsRepository,
  coreRepository: CoreRepository,
  controlStore: SyncControlStore,
  env: WorkerEnv
): Promise<DiscoveryResult> {
  let watermark = await coreRepository.getWatermark(SYNC_STREAM);

  if (!watermark) {
    // Primeira execucao: parte de onde o mirror ja chegou, e nao de NOW(),
    // para nao pular em silencio o que entrou enquanto o sync esteve parado.
    //
    // Sem mirror nenhum, o fallback e o PISO e nao a epoca: o mirror comeca em
    // 01/08/2026 de proposito, entao pedir tudo desde 1970 seria varrer 5,9 GB
    // no OMS para descartar o resultado no filtro logo abaixo.
    const mirrorMax = await coreRepository.findMirrorMaxSortAt();
    watermark = { sortAt: mirrorMax ?? env.SYNC_MIRROR_FLOOR_AT, recordId: "" };

    logInfo("sync_watermark_initialized", {
      cycleId,
      stream: SYNC_STREAM,
      sortAt: watermark.sortAt.toISOString(),
      derivedFrom: mirrorMax ? "mirror_max" : "floor",
    });
  }

  // Recuo pela folga: absorve insercoes fora de ordem no OMS.
  const cursor = {
    sortAt: new Date(watermark.sortAt.getTime() - env.SYNC_WATERMARK_GRACE_SECONDS * 1000),
    recordId: "",
  };

  const candidates = await omsRepository.findRawPayloadsAfter(cursor, env.BATCH_SIZE * 2);
  if (candidates.length === 0) {
    return { candidates: 0, missing: 0, queued: 0 };
  }

  // O recuo pela folga pode cair abaixo do piso; o piso decide o que entra.
  const withinFloor = partitionByMirrorFloor(candidates, env.SYNC_MIRROR_FLOOR_AT);

  const existingIds = await coreRepository.findExistingRawPayloadIds(
    withinFloor.eligible.map((item) => item.id)
  );
  const missing = withinFloor.eligible.filter((item) => !existingIds.has(item.id));
  const queued = await controlStore.enqueueBackfill(missing);

  // Avanca ate o ultimo item LIDO, nao o ultimo enfileirado: os que ja
  // estavam no mirror tambem estao cobertos, e parar neles regrediria o
  // cursor. Como a leitura e ASC, o ultimo do lote e o maior do keyset.
  const last = candidates[candidates.length - 1];
  const lastSortAt = last.receivedAt ?? last.processedAt;
  if (lastSortAt) {
    await coreRepository.setWatermark(SYNC_STREAM, { sortAt: lastSortAt, recordId: last.id });
  }

  logInfo("sync_incremental_enqueued", {
    cycleId,
    stream: SYNC_STREAM,
    fromSortAt: cursor.sortAt.toISOString(),
    toSortAt: lastSortAt ? lastSortAt.toISOString() : null,
    floorAt: env.SYNC_MIRROR_FLOOR_AT.toISOString(),
    candidates: candidates.length,
    belowFloor: withinFloor.belowFloor,
    undated: withinFloor.undated,
    missing: missing.length,
    queued,
    // Lote cheio significa que ha mais para ler; o proximo ciclo continua.
    hasMore: candidates.length >= env.BATCH_SIZE * 2,
  });

  return { candidates: candidates.length, missing: missing.length, queued };
}

export async function runSyncOnce(options: RunSyncOptions = {}): Promise<WorkerSummary> {
  const cycleId = randomUUID();
  const startedAt = Date.now();
  const env = getWorkerEnv();

  const omsPool = createOmsPool(env);
  const corePool = createCorePool(env);

  const omsRepository = new OmsRepository(omsPool);
  const coreRepository = new CoreRepository(corePool);

  // Controle tecnico (fila/retry/DLQ/lock) vive exclusivamente no CORE. O OMS
  // e fonte de leitura, ponto -- OmsRepository nem tem mais os metodos que
  // SyncControlStore exigiria.
  const controlStore: SyncControlStore = coreRepository;

  const summary: WorkerSummary = {
    phase: "running",
    fetched: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    deadLettered: 0,
    lockSkipped: false,
  };

  const discovery: SyncDiscovery =
    options.discovery ?? (env.SYNC_DISCOVERY_MODE === "ctid" ? { mode: "ctid" } : { mode: "incremental" });

  logInfo("sync_started", {
    cycleId,
    batchSize: env.BATCH_SIZE,
    maxRetries: env.MAX_RETRIES,
    discoveryMode: discovery.mode,
  });

  try {
    await controlStore.ensureInfrastructure();

    const hasLock = await controlStore.acquireExecutionLock(WORKER_LOCK_KEY);
    if (!hasLock) {
      summary.lockSkipped = true;
      summary.phase = "lock_skipped";
      logInfo("sync_skipped_lock_busy", { cycleId, lockKey: WORKER_LOCK_KEY });
      return summary;
    }

    const purged = await coreRepository.purgeExpiredDeadLetters(env.DLQ_RETENTION_DAYS);
    if (purged > 0) {
      logInfo("sync_dlq_purged", { cycleId, purged, retentionDays: env.DLQ_RETENTION_DAYS });
    }

    if (discovery.mode === "ctid") {
      // O heartbeat e gravado sempre, inclusive quando o ciclo falha: e o unico
      // registro que responde "o cron esta vivo?". Em 11/08 o cron morreu e
      // nada no banco guardou esse fato -- a ausencia de execucao nao deixava
      // rastro, e foi assim que 51% de buraco passou meses sem alarme.
      const logId = await coreRepository.startCycleLog(SYNC_STREAM, cycleId, options.triggerSource ?? "cron");

      try {
        const sweep = await sweepByPageCursor(omsRepository, coreRepository, env, cycleId, SYNC_STREAM);
        summary.processed += sweep.rowsRepaired;

        await coreRepository.finishCycleLog(logId, sweep.deadlineHit ? "deadline" : "ok", {
          tailBlocks: sweep.passes.find((p) => p.pass === "tail")?.blocksScanned ?? 0,
          auditBlocks: sweep.passes.find((p) => p.pass === "audit")?.blocksScanned ?? 0,
          rowsSeen: sweep.rowsSeen,
          rowsMissing: sweep.rowsMissing,
          rowsRepaired: sweep.rowsRepaired,
          omsMs: 0,
          coreMs: Date.now() - startedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await coreRepository
          .finishCycleLog(logId, "error", {
            tailBlocks: 0,
            auditBlocks: 0,
            rowsSeen: 0,
            rowsMissing: 0,
            rowsRepaired: 0,
            omsMs: 0,
            coreMs: Date.now() - startedAt,
            errorMessage: message,
          })
          .catch(() => {
            // Nao mascarar o erro original se o proprio log falhar.
          });
        throw error;
      }
    } else if (discovery.mode === "incremental") {
      await discoverIncremental(cycleId, omsRepository, coreRepository, controlStore, env);
    }

    const events = await controlStore.findPendingEvents(env.BATCH_SIZE, env.MAX_RETRIES);
    summary.fetched = events.length;

    for (const event of events) {
      try {
        if (event.tableName !== "raw_payloads") {
          summary.skipped += 1;
          const retries = await controlStore.markFailed(
            event,
            `table_name nao suportada: ${event.tableName}`
          );
          summary.retried += 1;

          if (retries >= env.MAX_RETRIES) {
            await controlStore.moveToDeadLetter(
              event,
              retries,
              `table_name nao suportada: ${event.tableName}`
            );
            summary.deadLettered += 1;
          }

          logInfo("sync_skipped_unsupported_table", {
            cycleId,
            eventId: event.id,
            tableName: event.tableName,
            retries,
          });
          continue;
        }

        const validation = validateSyncEvent(event);
        if (!validation.valid) {
          summary.failed += 1;
          const retries = await controlStore.markFailed(event, validation.reason);
          summary.retried += 1;

          if (retries >= env.MAX_RETRIES) {
            await controlStore.moveToDeadLetter(event, retries, validation.reason);
            summary.deadLettered += 1;
          }

          logError("sync_validation_failed", {
            cycleId,
            eventId: event.id,
            reason: validation.reason,
            retries,
          });
          continue;
        }

        if (event.operation === "DELETE") {
          await coreRepository.deleteRawPayloadById(event.recordId);
          await controlStore.markSynced(event.id);
          summary.processed += 1;
          continue;
        }

        const payloadRecord = mapPayloadToRawPayloadRecord(event);
        await coreRepository.upsertRawPayload(payloadRecord);
        await controlStore.markSynced(event.id);
        summary.processed += 1;
      } catch (err) {
        summary.failed += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const retries = await controlStore.markFailed(event, errorMessage);
        summary.retried += 1;

        if (retries >= env.MAX_RETRIES) {
          await controlStore.moveToDeadLetter(event, retries, errorMessage);
          summary.deadLettered += 1;
        }

        logError("sync_event_failed", {
          cycleId,
          eventId: event.id,
          operation: event.operation,
          error: errorMessage,
          retries,
        });
      }
    }

    logInfo("batch_processed", {
      cycleId,
      ...summary,
      durationMs: Date.now() - startedAt,
    });

    summary.phase = "completed";

    return summary;
  } finally {
    await controlStore.releaseExecutionLock(WORKER_LOCK_KEY).catch(() => {
      // Evita mascarar erro principal caso lock ja tenha sido liberado.
    });
    await Promise.all([omsPool.end(), corePool.end()]);
  }
}
