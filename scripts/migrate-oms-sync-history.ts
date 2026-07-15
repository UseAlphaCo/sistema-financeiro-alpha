/**
 * Migra o historico tecnico legado de sincronizacao do OMS
 * (integration.sync_events processados + integration.failed_jobs)
 * para a tabela de auditoria no CORE (integration.sync_audit_log).
 *
 * IMPORTANTE:
 * - Este script e SOMENTE LEITURA no OMS (nao escreve, nao faz DDL no OMS).
 * - A escrita no CORE e idempotente (ON CONFLICT DO NOTHING por source_id),
 *   entao pode ser executado varias vezes com seguranca.
 * - Por padrao roda em modo dry-run (apenas conta o que seria migrado).
 *   Use --apply para efetivamente gravar no CORE.
 *
 * Uso:
 *   npx tsx scripts/migrate-oms-sync-history.ts            # dry-run
 *   npx tsx scripts/migrate-oms-sync-history.ts --apply     # aplica
 *   npx tsx scripts/migrate-oms-sync-history.ts --apply --batch-size=500
 */
import 'dotenv/config';
import { Pool } from 'pg';

const BATCH_SIZE_DEFAULT = 500;

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const batchArg = args.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : BATCH_SIZE_DEFAULT;
  return { apply, batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : BATCH_SIZE_DEFAULT };
}

function requireEnv(name: string, fallbackName?: string): string {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    const label = fallbackName ? `${name} (ou ${fallbackName})` : name;
    throw new Error(`Variavel de ambiente ${label} nao configurada.`);
  }
  return value;
}

async function ensureAuditTable(corePool: Pool) {
  await corePool.query(`CREATE SCHEMA IF NOT EXISTS integration`);
  await corePool.query(`
    CREATE TABLE IF NOT EXISTS integration.sync_audit_log (
      id BIGSERIAL PRIMARY KEY,
      source_system TEXT NOT NULL DEFAULT 'oms',
      source_table TEXT NOT NULL,
      source_id BIGINT NOT NULL,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      retries INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      source_created_at TIMESTAMPTZ,
      source_processed_at TIMESTAMPTZ,
      migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await corePool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_audit_log_source
      ON integration.sync_audit_log(source_system, source_table, source_id)
  `);
}

async function migrateSyncEvents(omsPool: Pool, corePool: Pool, batchSize: number, apply: boolean) {
  let migrated = 0;
  // Paginacao por keyset (id > lastId) em vez de OFFSET: evita degradacao de
  // performance em tabelas grandes e nao pula/duplica linhas caso novos
  // eventos sejam processados durante a migracao (fallback de emergencia).
  let lastId = 0;

  // Somente eventos ja concluidos (processed = TRUE). Pendentes seguem
  // sendo tratados pelo fluxo normal via integration.sync_queue no CORE.
  const countRes = await omsPool.query(
    `SELECT COUNT(*)::int AS cnt FROM integration.sync_events WHERE processed = TRUE`
  );
  const total = countRes.rows[0]?.cnt ?? 0;
  console.log(`[sync_events] processados no OMS: ${total}`);

  if (!apply) return total;

  let processedSoFar = 0;
  for (;;) {
    const { rows } = await omsPool.query(
      `
        SELECT id, table_name, record_id, operation, retries, error_message, created_at, processed_at
        FROM integration.sync_events
        WHERE processed = TRUE AND id > $1
        ORDER BY id ASC
        LIMIT $2
      `,
      [lastId, batchSize]
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      const result = await corePool.query(
        `
          INSERT INTO integration.sync_audit_log (
            source_system, source_table, source_id, table_name, record_id,
            operation, status, retries, error_message, source_created_at, source_processed_at
          ) VALUES ('oms', 'sync_events', $1, $2, $3, $4, 'processed', $5, $6, $7, $8)
          ON CONFLICT (source_system, source_table, source_id) DO NOTHING
        `,
        [row.id, row.table_name, row.record_id, row.operation, row.retries, row.error_message, row.created_at, row.processed_at]
      );
      migrated += result.rowCount ?? 0;
    }

    lastId = rows[rows.length - 1].id;
    processedSoFar += rows.length;
    console.log(`[sync_events] progresso: ${processedSoFar}/${total}`);
  }

  return migrated;
}

async function migrateFailedJobs(omsPool: Pool, corePool: Pool, batchSize: number, apply: boolean) {
  let migrated = 0;
  let lastId = 0;

  const countRes = await omsPool.query(`SELECT COUNT(*)::int AS cnt FROM integration.failed_jobs`);
  const total = countRes.rows[0]?.cnt ?? 0;
  console.log(`[failed_jobs] registros no OMS: ${total}`);

  if (!apply) return total;

  let processedSoFar = 0;
  for (;;) {
    const { rows } = await omsPool.query(
      `
        SELECT id, table_name, record_id, operation, retries, error_message, moved_at
        FROM integration.failed_jobs
        WHERE id > $1
        ORDER BY id ASC
        LIMIT $2
      `,
      [lastId, batchSize]
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      const result = await corePool.query(
        `
          INSERT INTO integration.sync_audit_log (
            source_system, source_table, source_id, table_name, record_id,
            operation, status, retries, error_message, source_processed_at
          ) VALUES ('oms', 'failed_jobs', $1, $2, $3, $4, 'dead_letter', $5, $6, $7)
          ON CONFLICT (source_system, source_table, source_id) DO NOTHING
        `,
        [row.id, row.table_name, row.record_id, row.operation, row.retries, row.error_message, row.moved_at]
      );
      migrated += result.rowCount ?? 0;
    }

    lastId = rows[rows.length - 1].id;
    processedSoFar += rows.length;
    console.log(`[failed_jobs] progresso: ${processedSoFar}/${total}`);
  }

  return migrated;
}

async function main() {
  const { apply, batchSize } = parseArgs();

  const omsConnectionString = requireEnv('OMS_DB_URL');
  const coreConnectionString = requireEnv('CORE_DB_URL', 'DATABASE_URL');

  const omsPool = new Pool({ connectionString: omsConnectionString });
  const corePool = new Pool({ connectionString: coreConnectionString });

  console.log('migrate-oms-sync-history', { mode: apply ? 'APPLY' : 'DRY-RUN', batchSize });

  try {
    if (apply) {
      await ensureAuditTable(corePool);
    }

    const eventsResult = await migrateSyncEvents(omsPool, corePool, batchSize, apply);
    const failedResult = await migrateFailedJobs(omsPool, corePool, batchSize, apply);

    if (apply) {
      console.log(`Migrados/ja existentes -> sync_events: ${eventsResult}, failed_jobs: ${failedResult}`);
    } else {
      console.log(`DRY-RUN: seriam avaliados ${eventsResult} eventos de sync_events e ${failedResult} de failed_jobs.`);
      console.log('Execute novamente com --apply para gravar na tabela de auditoria (integration.sync_audit_log) no CORE.');
    }
  } finally {
    await Promise.all([omsPool.end(), corePool.end()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
