import 'dotenv/config';
import { startWorkerSyncJob, getWorkerSyncJob } from '../src/features/integration/worker-sync-jobs';
import { Pool } from 'pg';

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

async function getPendingOmsCount() {
  const pool = new Pool({ connectionString: process.env.OMS_DB_URL });
  try {
    const r = await pool.query("SELECT COUNT(*)::int AS cnt FROM integration.sync_events WHERE processed = FALSE");
    return r.rows[0].cnt as number;
  } catch (e) {
    console.error('error counting pending', e instanceof Error ? e.message : String(e));
    return Infinity;
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const days = Number(args[0] ?? 30) as 30 | 60 | 90;
  const maxRuns = Number(args[1] ?? 50);
  const iterations = Number(args[2] ?? 5);
  const pollInterval = Number(args[3] ?? 5000);
  const targetPending = Number(args[4] ?? 0);

  console.log('process-backlog start', { days, maxRuns, iterations, pollInterval, targetPending });

  for (let i = 0; i < iterations; i++) {
    const pendingBefore = await getPendingOmsCount();
    console.log(`Iteration ${i + 1} - pending before: ${pendingBefore}`);
    if (pendingBefore <= targetPending) {
      console.log('Target reached. Exiting.');
      break;
    }

    const job = await startWorkerSyncJob({ estimatedScopeDays: days, requestedBy: 'cli-backfill', requestId: `cli-${Date.now()}`, maxRuns });
    console.log('Started job', job.id);

    // poll job status
    while (true) {
      const j = await getWorkerSyncJob(job.id);
      console.log(`Job ${job.id} status: ${j?.status} runs: ${j?.runs}`);
      if (!j) break;
      if (j.status === 'completed' || j.status === 'failed') break;
      await sleep(pollInterval);
    }

    const pendingAfter = await getPendingOmsCount();
    console.log(`Iteration ${i + 1} - pending after: ${pendingAfter}`);

    if (pendingAfter <= targetPending) {
      console.log('Target reached after iteration. Exiting.');
      break;
    }

    // small pause between iterations
    await sleep(2000);
  }

  console.log('Process backlog finished');
}

main().catch((e) => { console.error(e); process.exit(1); });
