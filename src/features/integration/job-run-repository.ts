import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { logError } from "@/core/observability/logger";
import { getCoreConnectionString } from "@/shared/read-model-config";

/**
 * Registro de execucao de job (integration.job_runs).
 *
 * Por que existe: ate 08/09/2026 nenhum job fora do sync OMS->mirror deixava
 * vestigio consultavel. `logInfo`/`logError` vao para o stdout da Vercel e a
 * aplicacao nao consegue le-los. O unico sinal de materializacao era
 * `max(materialized_at)` em integration.financial_orders — e ele **nao
 * distingue "rodou e nada mudou" de "nao rodou"**, porque o UPSERT tem o guard
 * `content_hash IS DISTINCT FROM EXCLUDED.content_hash` e uma passagem sem
 * novidade nao mexe na coluna.
 *
 * Isso nao e' hipotetico: em 08/09/2026 o passe D-1 das 11:05 BRT nao produziu
 * escrita nenhuma, 6 pedidos de 07/09 (R$ 2.125,23) ficaram fora da tela o dia
 * inteiro, e a leitura de `max(materialized_at)` levou ao diagnostico errado de
 * que o cron havia rodado sem novidade. Uma linha aqui com `written: 0` teria
 * respondido a pergunta em um segundo.
 *
 * Regra de ouro deste modulo: **registrar nunca pode derrubar o job**. Toda
 * falha de escrita e' engolida e logada. Um cron que roda sem deixar registro e'
 * ruim; um cron que nao roda porque o registro falhou e' pior.
 */

const globalStore = globalThis as typeof globalThis & {
  __jobRunPool?: Pool;
};

/** Limite de execucoes guardadas. Purga no fim de cada escrita bem-sucedida. */
const RETENTION_DAYS = 90;

/** Uma purga a cada ~100 execucoes: nao vale uma query extra por invocacao. */
const PURGE_PROBABILITY = 0.01;

function getPool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) return null;

  if (!globalStore.__jobRunPool) {
    globalStore.__jobRunPool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      // Mesmo motivo de shopify-payment-resolution-repository.ts: sem keepAlive
      // uma conexao ociosa derrubada pelo pooler do Supabase so e' detectada
      // minutos depois, ja dentro da proxima invocacao do cron.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      idleTimeoutMillis: 15_000,
    });

    globalStore.__jobRunPool.on("error", (error) => {
      logError("job_run_pool_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return globalStore.__jobRunPool;
}

/** Fecha o pool. Existe para o teste de integracao nao segurar o processo. */
export async function closeJobRunPool(): Promise<void> {
  const pool = globalStore.__jobRunPool;
  if (!pool) return;
  globalStore.__jobRunPool = undefined;
  await pool.end();
}

export type JobRunStatus = "running" | "ok" | "failed";

export type JobRunRow = {
  id: string;
  job_name: string;
  started_at: string;
  finished_at: string | null;
  status: JobRunStatus;
  params: unknown | null;
  result: unknown | null;
  error_message: string | null;
  request_id: string | null;
  duration_ms: number | null;
};

export async function ensureJobRunsTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.job_runs (
      id uuid PRIMARY KEY,
      job_name text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT NOW(),
      finished_at timestamptz,
      status text NOT NULL,
      params jsonb,
      result jsonb,
      error_message text,
      request_id text,
      duration_ms integer
    )
  `);

  // O painel de /integracoes le "as execucoes recentes de cada job", que e'
  // exatamente este indice.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_job_runs_name_started_at
      ON integration.job_runs (job_name, started_at DESC)
  `);
}

/**
 * Abre a linha de execucao. Devolve o id, ou null se nao deu para registrar —
 * nesse caso o job segue normalmente e finishJobRun vira no-op.
 */
async function startJobRun(
  jobName: string,
  params: unknown,
  requestId: string | null
): Promise<string | null> {
  const pool = getPool();
  if (!pool) return null;

  const id = randomUUID();

  try {
    await ensureJobRunsTable();
    await pool.query(
      `INSERT INTO integration.job_runs (id, job_name, status, params, request_id)
       VALUES ($1, $2, 'running', $3, $4)`,
      [id, jobName, params === undefined ? null : JSON.stringify(params), requestId]
    );
    return id;
  } catch (error) {
    logError("job_run_start_failed", {
      jobName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function finishJobRun(
  id: string | null,
  status: Exclude<JobRunStatus, "running">,
  result: unknown,
  errorMessage: string | null
): Promise<void> {
  if (!id) return;

  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `UPDATE integration.job_runs
          SET status = $2,
              finished_at = NOW(),
              result = $3,
              error_message = $4,
              duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int
        WHERE id = $1`,
      [id, status, result === undefined ? null : JSON.stringify(result), errorMessage]
    );

    if (Math.random() < PURGE_PROBABILITY) {
      await pool.query(
        `DELETE FROM integration.job_runs
          WHERE started_at < NOW() - make_interval(days => $1::int)`,
        [RETENTION_DAYS]
      );
    }
  } catch (error) {
    logError("job_run_finish_failed", {
      jobRunId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Roda `fn` deixando uma linha de execucao, inclusive quando ela lanca.
 *
 * O valor devolvido por `fn` vira `result`, entao vale a pena devolver o resumo
 * do trabalho (quantas linhas escritas, quantos pedidos processados). E' esse
 * resumo que responde "rodou e nao mudou nada" — o caso que o painel precisa
 * distinguir de "nao rodou", e que nenhum outro sinal do sistema distingue.
 *
 * A excecao e' re-lancada: quem chama continua responsavel pelo erro.
 */
export async function withJobRun<T>(
  jobName: string,
  params: unknown,
  requestId: string | null,
  fn: () => Promise<T>
): Promise<T> {
  const id = await startJobRun(jobName, params, requestId);

  try {
    const result = await fn();
    await finishJobRun(id, "ok", result, null);
    return result;
  } catch (error) {
    await finishJobRun(
      id,
      "failed",
      null,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

/**
 * Execucoes recentes de um job, mais recente primeiro.
 *
 * E' a leitura do painel de /integracoes: a primeira linha e' "a ultima
 * execucao", e o conjunto alimenta a linha do tempo e o watchdog
 * (assessPipelineHealth em job-names.ts), que conta execucoes em 24 h contra o
 * esperado. Substituiu o `DISTINCT ON` por job, que so via a ultima e por isso
 * nao enxergava slot perdido nem falha que ja deixou de ser a mais recente.
 *
 * Casa com idx_job_runs_name_started_at. Tabela ainda inexistente vira lista
 * vazia, que o painel mostra como "sem registro".
 */
export async function listJobRunsByName(jobName: string, limit = 10): Promise<JobRunRow[]> {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query<JobRunRow>(
      `SELECT id, job_name, started_at, finished_at, status,
              params, result, error_message, request_id, duration_ms
         FROM integration.job_runs
        WHERE job_name = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [jobName, limit]
    );
    return result.rows;
  } catch (error) {
    logError("job_run_list_by_name_failed", {
      jobName,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
