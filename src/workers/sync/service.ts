import { randomUUID } from "node:crypto";

import { logError, logInfo } from "../../core/observability/logger";

import { getWorkerEnv } from "./config";
import { createCorePool, createOmsPool } from "./db";
import { CoreRepository } from "./repositories/core-repository";
import { OmsRepository } from "./repositories/oms-repository";
import type { WorkerSummary } from "./types";
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

  const summary: WorkerSummary = {
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
    backfillDays: options.backfillDays ?? null,
  });

  try {
    await omsRepository.ensureInfrastructure();

    const hasLock = await omsRepository.acquireExecutionLock(WORKER_LOCK_KEY);
    if (!hasLock) {
      summary.lockSkipped = true;
      logInfo("sync_skipped_lock_busy", { cycleId, lockKey: WORKER_LOCK_KEY });
      return summary;
    }

    if (options.backfillDays) {
      const backfillLimit = Math.min(
        Math.max(options.backfillLimit ?? env.BATCH_SIZE * 10, 1),
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
        const queued = await omsRepository.enqueueRawPayloadBackfill(missing);

        logInfo("sync_backfill_enqueued", {
          cycleId,
          days: options.backfillDays,
          candidates: candidates.length,
          missing: missing.length,
          queued,
        });
      }
    }

    const events = await omsRepository.findPendingEvents(env.BATCH_SIZE, env.MAX_RETRIES);
    summary.fetched = events.length;

    for (const event of events) {
      try {
        if (event.tableName !== "raw_payloads") {
          summary.skipped += 1;
          const retries = await omsRepository.markFailed(
            event,
            `table_name nao suportada: ${event.tableName}`
          );
          summary.retried += 1;

          if (retries >= env.MAX_RETRIES) {
            await omsRepository.moveToDeadLetter(
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
          const retries = await omsRepository.markFailed(event, validation.reason);
          summary.retried += 1;

          if (retries >= env.MAX_RETRIES) {
            await omsRepository.moveToDeadLetter(event, retries, validation.reason);
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
          await omsRepository.markProcessed(event.id);
          summary.processed += 1;
          continue;
        }

        const payloadRecord = mapPayloadToRawPayloadRecord(event);
        await coreRepository.upsertRawPayload(payloadRecord);
        await omsRepository.markProcessed(event.id);
        summary.processed += 1;
      } catch (err) {
        summary.failed += 1;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const retries = await omsRepository.markFailed(event, errorMessage);
        summary.retried += 1;

        if (retries >= env.MAX_RETRIES) {
          await omsRepository.moveToDeadLetter(event, retries, errorMessage);
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

    return summary;
  } finally {
    await omsRepository.releaseExecutionLock(WORKER_LOCK_KEY).catch(() => {
      // Evita mascarar erro principal caso lock ja tenha sido liberado.
    });
    await Promise.all([omsPool.end(), corePool.end()]);
  }
}
