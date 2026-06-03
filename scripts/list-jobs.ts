import 'dotenv/config';
import { Pool } from 'pg';

async function main(){
  const pool = new Pool({ connectionString: process.env.CORE_DB_URL ?? process.env.DATABASE_URL });
  const res = await pool.query(`SELECT id, status, requested_by, request_id, started_at, finished_at, runs, max_runs, summary FROM integration.worker_sync_jobs ORDER BY started_at DESC LIMIT 20`);
  for (const row of res.rows) {
    // simplify output
    console.log({
      id: row.id,
      status: row.status,
      requested_by: row.requested_by,
      request_id: row.request_id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      runs: row.runs,
      max_runs: row.max_runs,
      summary: row.summary,
    });
  }
  await pool.end();
}

main().catch((e)=>{ console.error(e); process.exit(1); });
