import { randomUUID } from "node:crypto";

import { logError, logInfo } from "../../core/observability/logger";

import { getWorkerEnv, type WorkerEnv } from "./config";
import { createCorePool, createOmsPool } from "./db";
import { CoreRepository } from "./repositories/core-repository";
import { OmsRepository } from "./repositories/oms-repository";
import type { SyncControlStore, WorkerSummary } from "./types";
import { mapPayloadToRawPayloadRecord, validateSyncEvent } from "./validation";

const WORKER_LOCK_KEY = 9382201;

/** Unico stream hoje: raw_payloads do OMS -> mirror do CORE. */
const SYNC_STREAM = "oms_raw_payloads";

/**
 * Como o ciclo descobre o que precisa entrar na fila.
 *
 * - "incremental": avanca por keyset a partir da marca d'agua. Padrao do
 *   ciclo automatico. Custo proporcional ao que chegou de novo.
 * - "window": varre uma janela de N dias. So por pedido explicito (tela
 *   /integracoes ou scripts/trigger-backfill.ts), para fechar lacunas.
 * - "none": nao descobre nada, apenas drena a fila. Usado nas execucoes
 *   seguintes de um job de backfill, que ja enfileirou tudo na primeira.
 */
type SyncDiscovery =
  | { mode: "incremental" }
  | { mode: "window"; days: 30 | 60 | 90; limit?: number }
  | { mode: "none" };

type RunSyncOptions = {
  discovery?: SyncDiscovery;
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
    const mirrorMax = await coreRepository.findMirrorMaxSortAt();
    watermark = { sortAt: mirrorMax ?? new Date(0), recordId: "" };

    logInfo("sync_watermark_initialized", {
      cycleId,
      stream: SYNC_STREAM,
      sortAt: watermark.sortAt.toISOString(),
      derivedFrom: mirrorMax ? "mirror_max" : "epoch",
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

  const existingIds = await coreRepository.findExistingRawPayloadIds(
    candidates.map((item) => item.id)
  );
  const missing = candidates.filter((item) => !existingIds.has(item.id));
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
    candidates: candidates.length,
    missing: missing.length,
    queued,
    // Lote cheio significa que ha mais para ler; o proximo ciclo continua.
    hasMore: candidates.length >= env.BATCH_SIZE * 2,
  });

  return { candidates: candidates.length, missing: missing.length, queued };
}

/**
 * Backfill por janela de dias. Fica fora do ciclo automatico de proposito —
 * so roda quando alguem pede explicitamente, pela tela /integracoes ou por
 * scripts/trigger-backfill.ts.
 */
async function discoverWindow(
  cycleId: string,
  discovery: { mode: "window"; days: 30 | 60 | 90; limit?: number },
  omsRepository: OmsRepository,
  coreRepository: CoreRepository,
  controlStore: SyncControlStore,
  env: WorkerEnv
): Promise<DiscoveryResult> {
  const backfillLimit = Math.min(Math.max(discovery.limit ?? env.BATCH_SIZE * 2, 1), 5000);
  const candidates = await omsRepository.findRawPayloadCandidates(discovery.days, backfillLimit);

  if (candidates.length === 0) {
    return { candidates: 0, missing: 0, queued: 0 };
  }

  const existingIds = await coreRepository.findExistingRawPayloadIds(
    candidates.map((item) => item.id)
  );
  const missing = candidates.filter((item) => !existingIds.has(item.id));
  const queued = await controlStore.enqueueBackfill(missing);

  logInfo("sync_backfill_enqueued", {
    cycleId,
    days: discovery.days,
    candidates: candidates.length,
    missing: missing.length,
    queued,
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

  // OMS read-only por padrao: o controle tecnico (fila/retry/DLQ/lock) vive no
  // CORE. "oms" existe apenas como fallback de emergencia (rollback controlado).
  const controlStore: SyncControlStore =
    env.SYNC_CONTROL_TARGET === "oms" ? omsRepository : coreRepository;

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

  const discovery: SyncDiscovery = options.discovery ?? { mode: "incremental" };

  logInfo("sync_started", {
    cycleId,
    batchSize: env.BATCH_SIZE,
    maxRetries: env.MAX_RETRIES,
    controlTarget: env.SYNC_CONTROL_TARGET,
    discoveryMode: discovery.mode,
    backfillDays: discovery.mode === "window" ? discovery.days : null,
  });

  try {
    await controlStore.ensureInfrastructure();

    if (controlStore !== coreRepository) {
      // Mirror e marca d'agua vivem sempre no CORE, mesmo com o controle
      // tecnico apontado para o OMS.
      await coreRepository.ensureInfrastructure();
    }

    const hasLock = await controlStore.acquireExecutionLock(WORKER_LOCK_KEY);
    if (!hasLock) {
      summary.lockSkipped = true;
      summary.phase = "lock_skipped";
      logInfo("sync_skipped_lock_busy", { cycleId, lockKey: WORKER_LOCK_KEY });
      return summary;
    }

    if (env.SYNC_CONTROL_TARGET === "core") {
      const purged = await coreRepository.purgeExpiredDeadLetters(env.DLQ_RETENTION_DAYS);
      if (purged > 0) {
        logInfo("sync_dlq_purged", { cycleId, purged, retentionDays: env.DLQ_RETENTION_DAYS });
      }
    }

    if (discovery.mode === "incremental") {
      await discoverIncremental(cycleId, omsRepository, coreRepository, controlStore, env);
    } else if (discovery.mode === "window") {
      await discoverWindow(cycleId, discovery, omsRepository, coreRepository, controlStore, env);
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
