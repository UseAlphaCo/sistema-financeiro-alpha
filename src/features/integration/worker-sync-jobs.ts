import { randomUUID } from "node:crypto";

import { runSyncOnce } from "@/workers/sync/service";
import {
  ensureJobsTable,
  insertJob,
  updateJob,
  getJob as getPersistedJob,
  getLatestRunningJob,
  PersistedJob,
} from "./worker-job-repository";
import type { WorkerSummary } from "@/workers/sync/types";

type WorkerSyncJobStatus = "queued" | "running" | "completed" | "failed";

type WorkerSyncPhase =
  | "queued"
  | "running"
  | "backfill_enqueued"
  | "processing_events"
  | "completed"
  | "failed"
  | "lock_skipped";

type WorkerSyncJob = {
  id: string;
  mode: "retroactive";
  estimatedScopeDays: 30 | 60 | 90;
  status: WorkerSyncJobStatus;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: string | null;
  requestId: string;
  maxRuns: number;
  runs: number;
  lastError: string | null;
  summary: WorkerSummary;
};

type StartWorkerSyncJobInput = {
  estimatedScopeDays: 30 | 60 | 90;
  requestedBy: string | null;
  requestId: string;
  maxRuns?: number;
};

function toRetroactiveMode(value: string | null | undefined): "retroactive" {
  return value === "retroactive" ? "retroactive" : "retroactive";
}

function withPhase(summary: WorkerSummary, phase: WorkerSyncPhase): WorkerSummary {
  return {
    ...summary,
    phase,
  };
}

function normalizeSummary(summary: unknown): WorkerSummary {
  const base = createInitialSummary();
  if (!summary || typeof summary !== "object") {
    return base;
  }

  const candidate = summary as Partial<WorkerSummary>;
  return {
    ...base,
    ...candidate,
    phase: candidate.phase ?? base.phase,
  };
}

function createInitialSummary(): WorkerSummary {
  return {
    phase: "queued",
    fetched: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    retried: 0,
    deadLettered: 0,
    lockSkipped: false,
  };
}



function mergeSummary(target: WorkerSummary, step: WorkerSummary): WorkerSummary {
  return {
    phase: step.phase ?? target.phase,
    fetched: target.fetched + step.fetched,
    processed: target.processed + step.processed,
    failed: target.failed + step.failed,
    skipped: target.skipped + step.skipped,
    retried: target.retried + step.retried,
    deadLettered: target.deadLettered + step.deadLettered,
    lockSkipped: target.lockSkipped || step.lockSkipped,
  };
}

async function executeWorkerJob(jobId: string): Promise<void> {
  const persisted = await getPersistedJob(jobId);
  if (!persisted) return;

  let currentSummary = withPhase(normalizeSummary(persisted.summary), "running");

  await updateJob(jobId, {
    status: "running",
    summary: currentSummary,
  } as Partial<PersistedJob>);

  for (let run = 1; run <= (persisted.max_runs ?? 1); run += 1) {
    const latest = await getPersistedJob(jobId);
    if (!latest) return;

    try {
      const phase = run === 1 ? "backfill_enqueued" : "processing_events";
      currentSummary = withPhase(currentSummary, phase);
      await updateJob(jobId, { summary: currentSummary } as Partial<PersistedJob>);

      const cycle = await runSyncOnce(
        run === 1
          ? {
              backfillDays: (latest.estimated_scope_days as unknown as 30 | 60 | 90) || undefined,
            }
          : {}
      );

      currentSummary = mergeSummary(currentSummary, cycle);

      if (cycle.lockSkipped) {
        currentSummary = withPhase(currentSummary, "lock_skipped");
        await updateJob(jobId, { summary: currentSummary } as Partial<PersistedJob>);
        break;
      }

      const nextPhase: WorkerSyncPhase = cycle.fetched === 0 ? "completed" : "processing_events";
      currentSummary = withPhase(currentSummary, nextPhase);
      await updateJob(jobId, {
        runs: run,
        summary: currentSummary,
      } as Partial<PersistedJob>);

      if (cycle.fetched === 0) {
        break;
      }
    } catch (error) {
      await updateJob(jobId, {
        status: "failed",
        summary: withPhase(currentSummary, "failed"),
        last_error: error instanceof Error ? error.message : String(error),
        finished_at: new Date().toISOString(),
      } as Partial<PersistedJob>);
      return;
    }
  }

  await updateJob(jobId, {
    status: "completed",
    summary: currentSummary.phase === "failed" ? currentSummary : currentSummary,
    finished_at: new Date().toISOString(),
  } as Partial<PersistedJob>);
}

export async function startWorkerSyncJob(input: StartWorkerSyncJobInput): Promise<WorkerSyncJob> {
  await ensureJobsTable();

  const running = await getLatestRunningJob();
  if (running && (running.status === "queued" || running.status === "running")) {
    return {
      id: running.id,
      mode: toRetroactiveMode(running.mode),
      estimatedScopeDays: (running.estimated_scope_days as number) as 30 | 60 | 90,
      status: running.status as WorkerSyncJobStatus,
      startedAt: running.started_at,
      finishedAt: running.finished_at ?? null,
      requestedBy: running.requested_by ?? null,
      requestId: running.request_id ?? "",
      maxRuns: running.max_runs ?? 20,
      runs: running.runs ?? 0,
      lastError: running.last_error ?? null,
      summary: normalizeSummary(running.summary),
    } as WorkerSyncJob;
  }

  const id = randomUUID();
  const maxRuns = Math.min(Math.max(input.maxRuns ?? 20, 1), 200);

  const persisted: PersistedJob = {
    id,
    mode: "retroactive",
    estimated_scope_days: input.estimatedScopeDays,
    status: "queued",
    started_at: new Date().toISOString(),
    finished_at: null,
    requested_by: input.requestedBy,
    request_id: input.requestId,
    max_runs: maxRuns,
    runs: 0,
    last_error: null,
    summary: createInitialSummary(),
  } as unknown as PersistedJob;

  await insertJob(persisted).catch(() => undefined);

  void executeWorkerJob(id);

  return {
    id,
    mode: "retroactive",
    estimatedScopeDays: input.estimatedScopeDays,
    status: "queued",
    startedAt: persisted.started_at,
    finishedAt: null,
    requestedBy: input.requestedBy,
    requestId: input.requestId,
    maxRuns,
    runs: 0,
    lastError: null,
    summary: createInitialSummary(),
  } as WorkerSyncJob;
}

export async function getWorkerSyncJob(jobId: string): Promise<WorkerSyncJob | null> {
  const persisted = await getPersistedJob(jobId);
  if (!persisted) return null;

  return {
    id: persisted.id,
    mode: toRetroactiveMode(persisted.mode),
    estimatedScopeDays: (persisted.estimated_scope_days as number) as 30 | 60 | 90,
    status: persisted.status as WorkerSyncJobStatus,
    startedAt: persisted.started_at,
    finishedAt: persisted.finished_at ?? null,
    requestedBy: persisted.requested_by ?? null,
    requestId: persisted.request_id ?? "",
    maxRuns: persisted.max_runs ?? 20,
    runs: persisted.runs ?? 0,
    lastError: persisted.last_error ?? null,
      summary: normalizeSummary(persisted.summary),
  } as WorkerSyncJob;
}

export async function getCurrentWorkerSyncJob(): Promise<WorkerSyncJob | null> {
  const running = await getLatestRunningJob();
  if (!running) return null;

  return {
    id: running.id,
    mode: toRetroactiveMode(running.mode),
    estimatedScopeDays: (running.estimated_scope_days as number) as 30 | 60 | 90,
    status: running.status as WorkerSyncJobStatus,
    startedAt: running.started_at,
    finishedAt: running.finished_at ?? null,
    requestedBy: running.requested_by ?? null,
    requestId: running.request_id ?? "",
    maxRuns: running.max_runs ?? 20,
    runs: running.runs ?? 0,
    lastError: running.last_error ?? null,
    summary: normalizeSummary(running.summary),
  } as WorkerSyncJob;
}

export type { WorkerSyncJob, WorkerSyncJobStatus };
