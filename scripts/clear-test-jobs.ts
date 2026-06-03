import 'dotenv/config';
import { Pool } from 'pg';

async function main(){
  const pool = new Pool({ connectionString: process.env.CORE_DB_URL ?? process.env.DATABASE_URL });
  const res = await pool.query(`DELETE FROM integration.worker_sync_jobs WHERE requested_by = $1 RETURNING id`, ['test@example.com']);
  console.log('deleted', res.rowCount, 'rows');
  await pool.end();
}

main().catch((e)=>{ console.error(e); process.exit(1); });
