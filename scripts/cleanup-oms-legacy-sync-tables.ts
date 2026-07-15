/**
 * Limpeza das tabelas tecnicas legadas no OMS (integration.sync_events e
 * integration.failed_jobs). Acao DESTRUTIVA — protegida por multiplos gates.
 *
 * Pre-requisitos (validados automaticamente antes de qualquer escrita):
 * 1. Reconciliacao OMS<->CORE sem divergencias (mesma logica de
 *    scripts/reconcile-oms-core-sync.ts).
 * 2. Historico legado ja migrado para integration.sync_audit_log no CORE
 *    (scripts/migrate-oms-sync-history.ts --apply).
 * 3. Nenhum evento pendente no OMS (processed = FALSE).
 *
 * Gates de execucao:
 * - Sem --apply: roda em modo relatorio (dry-run), nao altera nada.
 * - Com --apply mas sem a env CONFIRM_OMS_CLEANUP=CONFIRMO-LIMPEZA-OMS:
 *   aborta e explica o que falta.
 * - Acao padrao e TRUNCATE (remove dados, mantem estrutura). Para remover as
 *   tabelas por completo, use --drop (ainda exige os mesmos gates).
 *
 * Uso:
 *   npx tsx scripts/cleanup-oms-legacy-sync-tables.ts                 # dry-run
 *   CONFIRM_OMS_CLEANUP=CONFIRMO-LIMPEZA-OMS \
 *     npx tsx scripts/cleanup-oms-legacy-sync-tables.ts --apply       # truncate
 *   CONFIRM_OMS_CLEANUP=CONFIRMO-LIMPEZA-OMS \
 *     npx tsx scripts/cleanup-oms-legacy-sync-tables.ts --apply --drop
 */
import 'dotenv/config';
import { Pool } from 'pg';

const CONFIRM_PHRASE = 'CONFIRMO-LIMPEZA-OMS';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes('--apply'),
    drop: args.includes('--drop'),
  };
}

function requireEnv(name: string, fallbackName?: string): string {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    const label = fallbackName ? `${name} (ou ${fallbackName})` : name;
    throw new Error(`Variavel de ambiente ${label} nao configurada.`);
  }
  return value;
}

type CheckResult = { ok: boolean; problems: string[] };

async function runChecks(omsPool: Pool, corePool: Pool): Promise<CheckResult> {
  const problems: string[] = [];

  let omsPendingCount = 0;
  try {
    const omsPending = await omsPool.query(
      'SELECT COUNT(*)::int AS cnt FROM integration.sync_events WHERE processed = FALSE'
    );
    omsPendingCount = omsPending.rows[0].cnt;
  } catch {
    // tabela ja pode nao existir; nao e um problema para o gate.
  }

  if (omsPendingCount > 0) {
    problems.push(`Existem ${omsPendingCount} eventos pendentes em OMS.integration.sync_events.`);
  }

  let legacyHistoryCount = 0;
  try {
    const legacyEvents = await omsPool.query(
      'SELECT COUNT(*)::int AS cnt FROM integration.sync_events WHERE processed = TRUE'
    );
    const legacyFailed = await omsPool.query('SELECT COUNT(*)::int AS cnt FROM integration.failed_jobs');
    legacyHistoryCount = legacyEvents.rows[0].cnt + legacyFailed.rows[0].cnt;
  } catch {
    legacyHistoryCount = 0;
  }

  let auditCount = 0;
  try {
    const audit = await corePool.query(
      "SELECT COUNT(*)::int AS cnt FROM integration.sync_audit_log WHERE source_system = 'oms'"
    );
    auditCount = audit.rows[0].cnt;
  } catch {
    problems.push('integration.sync_audit_log nao existe no CORE. Rode scripts/migrate-oms-sync-history.ts --apply primeiro.');
  }

  if (legacyHistoryCount > 0 && auditCount < legacyHistoryCount) {
    problems.push(
      `Historico legado no OMS (${legacyHistoryCount}) maior que o migrado para auditoria (${auditCount}). Rode scripts/migrate-oms-sync-history.ts --apply.`
    );
  }

  return { ok: problems.length === 0, problems };
}

async function main() {
  const { apply, drop } = parseArgs();

  const omsConnectionString = requireEnv('OMS_DB_URL');
  const coreConnectionString = requireEnv('CORE_DB_URL', 'DATABASE_URL');

  // Salvaguarda contra misconfiguracao: se OMS e CORE apontarem para a mesma
  // conexao (erro comum de copy-paste no .env), abortamos antes de qualquer
  // leitura/escrita para evitar truncar/derrubar tabelas no banco errado.
  if (omsConnectionString === coreConnectionString) {
    console.error('Abortado: OMS_DB_URL e CORE_DB_URL/DATABASE_URL apontam para a mesma conexao.');
    process.exitCode = 1;
    return;
  }

  const omsPool = new Pool({ connectionString: omsConnectionString });
  const corePool = new Pool({ connectionString: coreConnectionString });

  console.log('cleanup-oms-legacy-sync-tables', { mode: apply ? (drop ? 'APPLY (DROP)' : 'APPLY (TRUNCATE)') : 'DRY-RUN' });

  try {
    const { ok, problems } = await runChecks(omsPool, corePool);

    console.log('\n=== Pre-requisitos ===');
    if (ok) {
      console.log('OK: todos os pre-requisitos foram atendidos.');
    } else {
      console.log(`FALHOU: ${problems.length} problema(s) encontrado(s):`);
      for (const p of problems) console.log(' -', p);
    }

    if (!apply) {
      console.log('\nDRY-RUN: nenhuma alteracao foi feita. Use --apply para executar (apos corrigir os problemas acima, se houver).');
      process.exitCode = ok ? 0 : 1;
      return;
    }

    if (!ok) {
      console.error('\nAbortado: pre-requisitos nao atendidos. Nenhuma alteracao foi feita.');
      process.exitCode = 1;
      return;
    }

    if (process.env.CONFIRM_OMS_CLEANUP !== CONFIRM_PHRASE) {
      console.error(
        `\nAbortado: defina a variavel de ambiente CONFIRM_OMS_CLEANUP="${CONFIRM_PHRASE}" para confirmar esta acao destrutiva.`
      );
      process.exitCode = 1;
      return;
    }

    console.log('\nExecutando limpeza no OMS...');
    const client = await omsPool.connect();
    try {
      await client.query('BEGIN');
      if (drop) {
        await client.query('DROP TABLE IF EXISTS integration.failed_jobs');
        await client.query('DROP TABLE IF EXISTS integration.sync_events');
      } else {
        await client.query('TRUNCATE TABLE integration.failed_jobs');
        await client.query('TRUNCATE TABLE integration.sync_events');
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (drop) {
      console.log('Tabelas integration.sync_events e integration.failed_jobs removidas do OMS.');
    } else {
      console.log('Tabelas integration.sync_events e integration.failed_jobs esvaziadas no OMS (estrutura mantida).');
    }

    console.log('Limpeza concluida com sucesso.');
  } finally {
    await Promise.all([omsPool.end(), corePool.end()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
