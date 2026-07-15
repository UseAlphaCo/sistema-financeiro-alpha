import { randomUUID } from "node:crypto";

import { logError, logInfo } from "../../core/observability/logger";

import { getWorkerEnv } from "./config";
import { createCorePool, createOmsPool } from "./db";
import { CoreRepository } from "./repositories/core-repository";
import { OmsRepository } from "./repositories/oms-repository";
import type { SyncControlStore, WorkerSummary } from "./types";
import { mapPayloadToRawPayloadRecord, validateSyncEvent } from "./validation";

const WORKER_LOCK_KEY = 9382201;

type RunSyncOptions = {
  backfillDays?: 30 | 60 | 90;
  backfillLimit?: number;
};

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

  logInfo("sync_started", {
    cycleId,
    batchSize: env.BATCH_SIZE,
    maxRetries: env.MAX_RETRIES,
    controlTarget: env.SYNC_CONTROL_TARGET,
    backfillDays: options.backfillDays ?? null,
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

    if (env.SYNC_CONTROL_TARGET === "core") {
      const purged = await coreRepository.purgeExpiredDeadLetters(env.DLQ_RETENTION_DAYS);
      if (purged > 0) {
        logInfo("sync_dlq_purged", { cycleId, purged, retentionDays: env.DLQ_RETENTION_DAYS });
      }
    }

    if (options.backfillDays) {
      const backfillLimit = Math.min(
        Math.max(options.backfillLimit ?? env.BATCH_SIZE * 2, 1),
        5000
      );
      const candidates = await omsRepository.findRawPayloadCandidates(
        options.backfillDays,
        backfillLimit
      );

      if (candidates.length > 0) {
        const existingIds = await coreRepository.findExistingRawPayloadIds(
          candidates.map((item) => item.id)
        );

        const missing = candidates.filter((item) => !existingIds.has(item.id));
        const queued = await controlStore.enqueueBackfill(missing);

        logInfo("sync_backfill_enqueued", {
          cycleId,
          days: options.backfillDays,
          candidates: candidates.length,
          missing: missing.length,
          queued,
        });
      }
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
