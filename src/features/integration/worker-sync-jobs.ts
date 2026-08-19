import { randomUUID } from "node:crypto";

import { getWorkerEnv } from "@/workers/sync/config";
import { createCorePool } from "@/workers/sync/db";
import { CoreRepository, type SweepStatus } from "@/workers/sync/repositories/core-repository";
import { runSyncOnce, SYNC_STREAM } from "@/workers/sync/service";
import {
  ensureJobsTable,
  insertJob,
  updateJob,
  getJob as getPersistedJob,
  getLatestRunningJob,
  failStaleRunningJobs,
  PersistedJob,
} from "./worker-job-repository";
import type { WorkerSummary } from "@/workers/sync/types";

const STALE_JOB_MAX_AGE_MINUTES = 15;

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
  /**
   * Pede explicitamente um backfill por janela de N dias. Omitido, o job faz
   * apenas descoberta incremental por marca d'agua — o modo do ciclo
   * automatico. So os disparos manuais (tela /integracoes e
   * scripts/trigger-backfill.ts) devem preencher isto.
   */
  backfillWindowDays?: 30 | 60 | 90;
  /**
   * Quando true, aguarda a execucao terminar antes de responder. Necessario
   * para o disparo via cron serverless: sem isso a function pode ser
   * congelada apos a resposta HTTP, matando o job no meio (fetched/processed
   * sempre 0). O disparo manual (com polling via worker/status) continua
   * fire-and-forget, pois pode envolver ate 200 runs.
   */
  awaitCompletion?: boolean;
};

function toRetroactiveMode(value: string | null | undefined): "retroactive" {
  return value === "retroactive" ? "retroactive" : "retroactive";
}

function normalizeBackfillWindow(value: number | null | undefined): 30 | 60 | 90 | null {
  if (value === 30 || value === 60 || value === 90) return value;
  return null;
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

function mapPersistedJob(persisted: PersistedJob): WorkerSyncJob {
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

  const windowBackfill = normalizeBackfillWindow(persisted.backfill_window_days);

  let currentSummary = withPhase(normalizeSummary(persisted.summary), "running");

  await updateJob(jobId, {
    status: "running",
    summary: currentSummary,
  } as Partial<PersistedJob>);

  for (let run = 1; run <= (persisted.max_runs ?? 1); run += 1) {
    const latest = await getPersistedJob(jobId);
    if (!latest) return;

    try {
      const phase: WorkerSyncPhase =
        windowBackfill && run === 1 ? "backfill_enqueued" : "processing_events";
      currentSummary = withPhase(currentSummary, phase);
      await updateJob(jobId, { summary: currentSummary } as Partial<PersistedJob>);

      // O backfill por janela so acontece quando alguem pede explicitamente,
      // e apenas na primeira execucao — as seguintes drenam o que ela
      // enfileirou. Sem pedido explicito (o caso do cron), o ciclo faz
      // descoberta incremental por marca d'agua.
      //
      // Antes, run === 1 passava backfillDays incondicionalmente: com o cron
      // em */5, era uma varredura de 30 dias 288 vezes por dia sobre as
      // mesmas linhas.
      // Sem pedido explicito de janela (o caso do cron), a descoberta segue o
      // SYNC_DISCOVERY_MODE — hoje "ctid", a varredura por cursor fisico.
      // Deixar runSyncOnce resolver o padrao evita que este ponto fixe
      // "incremental" e mascare a configuracao, como acontecia antes.
      const cycle = await runSyncOnce(
        windowBackfill
          ? { discovery: run === 1 ? { mode: "window", days: windowBackfill } : { mode: "none" } }
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
  await failStaleRunningJobs(STALE_JOB_MAX_AGE_MINUTES);

  const running = await getLatestRunningJob();
  if (running && (running.status === "queued" || running.status === "running")) {
    return mapPersistedJob(running);
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
    backfill_window_days: input.backfillWindowDays ?? null,
  } as unknown as PersistedJob;

  await insertJob(persisted).catch(() => undefined);

  if (input.awaitCompletion) {
    await executeWorkerJob(id);

    const finalJob = await getPersistedJob(id);
    if (finalJob) {
      return mapPersistedJob(finalJob);
    }
  } else {
    void executeWorkerJob(id);
  }

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

  return mapPersistedJob(persisted);
}

export async function getCurrentWorkerSyncJob(): Promise<WorkerSyncJob | null> {
  await ensureJobsTable();
  await failStaleRunningJobs(STALE_JOB_MAX_AGE_MINUTES);

  const running = await getLatestRunningJob();
  if (!running) return null;

  return mapPersistedJob(running);
}

/**
 * Estado da varredura fisica do heap do OMS. Nao depende de job nenhum: e o que
 * responde "o mirror esta completo?" e "o ciclo esta vivo?" quando nada esta
 * rodando -- exatamente o cenario de 11/08 a 18/08, em que a tela ficou muda.
 *
 * Abre e fecha um pool proprio porque e um caminho de leitura pontual, disparado
 * pela tela, e nao parte do ciclo do worker.
 */
export async function getSyncSweepStatus(): Promise<SweepStatus> {
  const env = getWorkerEnv();
  const pool = createCorePool(env);

  try {
    return await new CoreRepository(pool).getSweepStatus(SYNC_STREAM);
  } finally {
    await pool.end();
  }
}

export type { WorkerSyncJob, WorkerSyncJobStatus };
