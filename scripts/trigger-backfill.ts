import 'dotenv/config';
import { startWorkerSyncJob } from '../src/features/integration/worker-sync-jobs';

async function main() {
  const args = process.argv.slice(2);
  const days = Number(args[0] ?? 30) as 30 | 60 | 90;
  const maxRuns = Number(args[1] ?? 50);

  console.log('Starting backfill job with', { days, maxRuns });

  // Disparo manual: pede o backfill por janela explicitamente.
  const job = await startWorkerSyncJob({
    estimatedScopeDays: days,
    backfillWindowDays: days,
    requestedBy: 'cli-trigger',
    requestId: `cli-${Date.now()}`,
    maxRuns,
  });

  console.log('Job started:', job);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
