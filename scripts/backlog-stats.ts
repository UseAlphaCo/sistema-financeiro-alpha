import 'dotenv/config';
import { Pool } from 'pg';

async function queryCore() {
  const pool = new Pool({ connectionString: process.env.CORE_DB_URL ?? process.env.DATABASE_URL });
  try {
    const r1 = await pool.query('SELECT COUNT(*)::int AS cnt FROM mirror.raw_payloads');
    const r2 = await pool.query('SELECT COUNT(*)::int AS cnt FROM integration.sync_queue');
    const r3 = await pool.query('SELECT COUNT(*)::int AS cnt FROM integration.failed_jobs');
    console.log('CORE mirror.raw_payloads:', r1.rows[0].cnt);
    console.log('CORE integration.sync_queue (pending):', r2.rows[0].cnt);
    console.log('CORE integration.failed_jobs (dead letter):', r3.rows[0].cnt);
  } catch (e) {
    console.error('CORE query error', e instanceof Error ? e.message : String(e));
  } finally {
    await pool.end();
  }
}

async function queryOms() {
  const pool = new Pool({ connectionString: process.env.OMS_DB_URL });
  try {
    // OMS e read-only: apenas a origem de dados raw_payloads.
    const r1 = await pool.query('SELECT COUNT(*)::int AS cnt FROM raw_payloads');
    console.log('OMS raw_payloads:', r1.rows[0].cnt);
  } catch (e) {
    console.error('OMS query error', e instanceof Error ? e.message : String(e));
  } finally {
    await pool.end();
  }
}

async function main(){
  await queryCore();
  await queryOms();
}

main().catch((e)=>{ console.error(e); process.exit(1); });
