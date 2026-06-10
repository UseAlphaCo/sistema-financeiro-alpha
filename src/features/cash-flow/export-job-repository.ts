import { Pool } from "pg";

type ExportFormat = "csv" | "xlsx";
type ExportJobStatus = "queued" | "running" | "completed" | "failed";

const globalStore = globalThis as typeof globalThis & {
  __cashFlowExportPool?: Pool;
};

function getPool(): Pool | null {
  const connectionString = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;
  if (!connectionString) return null;

  if (!globalStore.__cashFlowExportPool) {
    globalStore.__cashFlowExportPool = new Pool({ connectionString, max: 2 });
  }

  return globalStore.__cashFlowExportPool;
}

export type PersistedCashFlowExportJob = {
  id: string;
  status: ExportJobStatus;
  format: ExportFormat;
  filters: unknown;
  requested_by: string | null;
  request_id: string | null;
  started_at: string;
  finished_at: string | null;
  expires_at: string | null;
  total_rows: number;
  processed_rows: number;
  file_name: string | null;
  mime_type: string | null;
  file_data: Buffer | null;
  file_size_bytes: number | null;
  last_error: string | null;
};

async function purgeExpiredCashFlowExportFiles(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `UPDATE integration.cash_flow_export_jobs
     SET file_data = NULL,
         file_name = NULL,
         mime_type = NULL,
         file_size_bytes = NULL
     WHERE status = 'completed'
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()
       AND file_data IS NOT NULL`
  );
}

export async function ensureCashFlowExportJobsTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await purgeExpiredCashFlowExportFiles();

  await pool.query("CREATE SCHEMA IF NOT EXISTS integration");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.cash_flow_export_jobs (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      format text NOT NULL,
      filters jsonb NOT NULL,
      requested_by text,
      request_id text,
      started_at timestamptz NOT NULL,
      finished_at timestamptz,
      expires_at timestamptz,
      total_rows int NOT NULL DEFAULT 0,
      processed_rows int NOT NULL DEFAULT 0,
      file_name text,
      mime_type text,
      file_data bytea,
      file_size_bytes int,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_cash_flow_export_jobs_requested_by_started_at
    ON integration.cash_flow_export_jobs (requested_by, started_at DESC)
  `);
}

export async function insertCashFlowExportJob(
  job: Omit<PersistedCashFlowExportJob, "file_data"> & { file_data?: Buffer | null }
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO integration.cash_flow_export_jobs (
      id, status, format, filters, requested_by, request_id, started_at, finished_at, expires_at,
      total_rows, processed_rows, file_name, mime_type, file_data, file_size_bytes, last_error
    ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT (id) DO NOTHING`,
    [
      job.id,
      job.status,
      job.format,
      JSON.stringify(job.filters ?? {}),
      job.requested_by,
      job.request_id,
      job.started_at,
      job.finished_at,
      job.expires_at,
      job.total_rows,
      job.processed_rows,
      job.file_name,
      job.mime_type,
      job.file_data ?? null,
      job.file_size_bytes,
      job.last_error,
    ]
  );
}

export async function updateCashFlowExportJob(
  jobId: string,
  fields: Partial<Omit<PersistedCashFlowExportJob, "id">>
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  const entries = Object.entries(fields);
  if (entries.length === 0) return;

  const sets: string[] = [];
  const values: unknown[] = [];

  entries.forEach(([key, value], index) => {
    if (key === "filters") {
      sets.push(`${key} = $${index + 1}::jsonb`);
      values.push(JSON.stringify(value ?? {}));
      return;
    }

    sets.push(`${key} = $${index + 1}`);
    values.push(value);
  });

  values.push(jobId);

  await pool.query(
    `UPDATE integration.cash_flow_export_jobs
     SET ${sets.join(",")}
     WHERE id = $${values.length}`,
    values
  );
}

export async function getCashFlowExportJob(
  jobId: string
): Promise<PersistedCashFlowExportJob | null> {
  const pool = getPool();
  if (!pool) return null;

  await purgeExpiredCashFlowExportFiles();

  const result = await pool.query<PersistedCashFlowExportJob>(
    `SELECT
      id, status, format, filters, requested_by, request_id, started_at, finished_at, expires_at,
      total_rows, processed_rows, file_name, mime_type, file_data, file_size_bytes, last_error
     FROM integration.cash_flow_export_jobs
     WHERE id = $1`,
    [jobId]
  );

  return result.rows[0] ?? null;
}

export async function getLatestCashFlowExportJobByRequester(
  requestedBy: string | null
): Promise<PersistedCashFlowExportJob | null> {
  const pool = getPool();
  if (!pool) return null;

  await purgeExpiredCashFlowExportFiles();

  const result = await pool.query<PersistedCashFlowExportJob>(
    requestedBy
      ? `SELECT
           id, status, format, filters, requested_by, request_id, started_at, finished_at, expires_at,
           total_rows, processed_rows, file_name, mime_type, file_data, file_size_bytes, last_error
         FROM integration.cash_flow_export_jobs
         WHERE requested_by = $1
         ORDER BY started_at DESC
         LIMIT 1`
      : `SELECT
           id, status, format, filters, requested_by, request_id, started_at, finished_at, expires_at,
           total_rows, processed_rows, file_name, mime_type, file_data, file_size_bytes, last_error
         FROM integration.cash_flow_export_jobs
         ORDER BY started_at DESC
         LIMIT 1`,
    requestedBy ? [requestedBy] : []
  );

  return result.rows[0] ?? null;
}
