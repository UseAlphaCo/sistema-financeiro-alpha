import { Pool } from "pg";

const globalStore = globalThis as typeof globalThis & {
  __workerJobPool?: Pool;
};

function getPool(): Pool | null {
  const connectionString = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!globalStore.__workerJobPool) {
    globalStore.__workerJobPool = new Pool({ connectionString, max: 2 });
  }

  return globalStore.__workerJobPool;
}

export type PersistedJob = {
  id: string;
  mode: string;
  estimated_scope_days: number;
  status: string;
  started_at: string;
  finished_at: string | null;
  requested_by: string | null;
  request_id: string;
  max_runs: number;
  runs: number;
  last_error: string | null;
  summary: unknown | null;
};

export async function ensureJobsTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.worker_sync_jobs (
      id uuid PRIMARY KEY,
      mode text NOT NULL,
      estimated_scope_days int,
      status text NOT NULL,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      requested_by text,
      request_id text,
      max_runs int,
      runs int DEFAULT 0,
      last_error text,
      summary jsonb,
      created_at timestamptz DEFAULT NOW()
    )
  `);
}

export async function insertJob(job: Omit<PersistedJob, "created_at">): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO integration.worker_sync_jobs (
      id, mode, estimated_scope_days, status, started_at, finished_at, requested_by, request_id, max_runs, runs, last_error, summary
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, runs = EXCLUDED.runs, last_error = EXCLUDED.last_error, summary = EXCLUDED.summary, finished_at = EXCLUDED.finished_at`,
    [
      job.id,
      job.mode,
      job.estimated_scope_days,
      job.status,
      job.started_at,
      job.finished_at,
      job.requested_by,
      job.request_id,
      job.max_runs,
      job.runs,
      job.last_error,
      job.summary,
    ]
  );
}

export async function updateJob(jobId: string, fields: Partial<PersistedJob>): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${idx}`);
    values.push(v as unknown);
    idx += 1;
  }

  if (sets.length === 0) return;

  values.push(jobId);
  const sql = `UPDATE integration.worker_sync_jobs SET ${sets.join(",")} WHERE id = $${idx}`;
  await pool.query(sql, values);
}

export async function getJob(jobId: string): Promise<PersistedJob | null> {
  const pool = getPool();
  if (!pool) return null;

  const res = await pool.query(`SELECT id, mode, estimated_scope_days, status, started_at, finished_at, requested_by, request_id, max_runs, runs, last_error, summary FROM integration.worker_sync_jobs WHERE id = $1`, [jobId]);
  return res.rows[0] ?? null;
}

export async function getLatestRunningJob(): Promise<PersistedJob | null> {
  const pool = getPool();
  if (!pool) return null;

  const res = await pool.query(
    `SELECT id, mode, estimated_scope_days, status, started_at, finished_at, requested_by, request_id, max_runs, runs, last_error, summary
     FROM integration.worker_sync_jobs
     WHERE status = 'queued' OR status = 'running'
     ORDER BY started_at DESC
     LIMIT 1`
  );

  return res.rows[0] ?? null;
}

export async function failStaleRunningJobs(maxAgeMinutes: number): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;

  const safeMaxAge = Math.max(1, Math.floor(maxAgeMinutes));
  const staleError = `job marcado como stale apos ${safeMaxAge} minuto(s) sem conclusao`;

  const res = await pool.query(
    `UPDATE integration.worker_sync_jobs
     SET status = 'failed',
         finished_at = NOW(),
         last_error = COALESCE(last_error, $2),
         summary = jsonb_set(
           COALESCE(summary, '{}'::jsonb),
           '{phase}',
           '"failed"'::jsonb,
           true
         )
     WHERE (status = 'queued' OR status = 'running')
       AND finished_at IS NULL
       AND started_at < NOW() - ($1::int * INTERVAL '1 minute')`,
    [safeMaxAge, staleError]
  );

  return res.rowCount ?? 0;
}

export async function closePool(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  await pool.end();
  delete globalStore.__workerJobPool;
}
