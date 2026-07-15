/**
 * Reconciliacao de contagens OMS <-> CORE, usada como pre-requisito antes de
 * qualquer limpeza de tabelas legadas no OMS (integration.sync_events e
 * integration.failed_jobs). Este script e SOMENTE LEITURA em ambos os bancos.
 *
 * Verificacoes:
 * 1. raw_payloads (OMS) vs mirror.raw_payloads (CORE) — cobertura do mirror.
 * 2. sync_events pendentes no OMS (processed = FALSE) — deve ser 0 (fluxo
 *    ativo passou a usar integration.sync_queue no CORE).
 * 3. Historico legado (sync_events processados + failed_jobs) no OMS vs
 *    quantidade ja migrada para integration.sync_audit_log no CORE.
 *
 * Saida: relatorio no console. Exit code 1 se alguma verificacao falhar,
 * sinalizando que NAO e seguro prosseguir com a limpeza do OMS.
 *
 * Uso:
 *   npx tsx scripts/reconcile-oms-core-sync.ts
 */
import 'dotenv/config';
import { Pool } from 'pg';

function requireEnv(name: string, fallbackName?: string): string {
  const value = process.env[name] ?? (fallbackName ? process.env[fallbackName] : undefined);
  if (!value) {
    const label = fallbackName ? `${name} (ou ${fallbackName})` : name;
    throw new Error(`Variavel de ambiente ${label} nao configurada.`);
  }
  return value;
}

async function main() {
  const omsPool = new Pool({ connectionString: requireEnv('OMS_DB_URL') });
  const corePool = new Pool({ connectionString: requireEnv('CORE_DB_URL', 'DATABASE_URL') });

  const problems: string[] = [];

  try {
    const [omsRawCount, coreMirrorCount] = await Promise.all([
      omsPool.query('SELECT COUNT(*)::int AS cnt FROM raw_payloads'),
      corePool.query('SELECT COUNT(*)::int AS cnt FROM mirror.raw_payloads'),
    ]);

    console.log('--- Cobertura do mirror ---');
    console.log('OMS raw_payloads:', omsRawCount.rows[0].cnt);
    console.log('CORE mirror.raw_payloads:', coreMirrorCount.rows[0].cnt);
    if (coreMirrorCount.rows[0].cnt < omsRawCount.rows[0].cnt) {
      problems.push(
        `mirror.raw_payloads (${coreMirrorCount.rows[0].cnt}) tem menos registros que raw_payloads (${omsRawCount.rows[0].cnt}). Sync pode estar incompleto.`
      );
    }

    console.log('\n--- Backlog pendente ---');
    let omsPendingCount = 0;
    try {
      const omsPending = await omsPool.query(
        "SELECT COUNT(*)::int AS cnt FROM integration.sync_events WHERE processed = FALSE"
      );
      omsPendingCount = omsPending.rows[0].cnt;
      console.log('OMS integration.sync_events (pending, legado):', omsPendingCount);
      if (omsPendingCount > 0) {
        problems.push(
          `Existem ${omsPendingCount} eventos pendentes no OMS.integration.sync_events (legado). Rode o worker ate zerar antes da limpeza.`
        );
      }
    } catch {
      console.log('OMS integration.sync_events: tabela ja removida ou inacessivel (ok se limpeza ja ocorreu).');
    }

    const corePending = await corePool.query('SELECT COUNT(*)::int AS cnt FROM integration.sync_queue');
    console.log('CORE integration.sync_queue (pending, atual):', corePending.rows[0].cnt);

    console.log('\n--- Historico legado vs auditoria ---');
    let legacyHistoryCount = 0;
    try {
      const legacyEvents = await omsPool.query(
        'SELECT COUNT(*)::int AS cnt FROM integration.sync_events WHERE processed = TRUE'
      );
      const legacyFailed = await omsPool.query('SELECT COUNT(*)::int AS cnt FROM integration.failed_jobs');
      legacyHistoryCount = legacyEvents.rows[0].cnt + legacyFailed.rows[0].cnt;
      console.log('OMS historico legado (sync_events processados + failed_jobs):', legacyHistoryCount);
    } catch {
      console.log('OMS tabelas legadas ja removidas ou inacessiveis.');
    }

    let auditCount = 0;
    try {
      const audit = await corePool.query(
        "SELECT COUNT(*)::int AS cnt FROM integration.sync_audit_log WHERE source_system = 'oms'"
      );
      auditCount = audit.rows[0].cnt;
      console.log('CORE integration.sync_audit_log (migrado):', auditCount);
    } catch {
      console.log('CORE integration.sync_audit_log ainda nao existe (rode migrate-oms-sync-history.ts --apply).');
    }

    if (legacyHistoryCount > 0 && auditCount < legacyHistoryCount) {
      problems.push(
        `Historico legado no OMS (${legacyHistoryCount}) ainda nao foi totalmente migrado para integration.sync_audit_log (${auditCount}). Rode scripts/migrate-oms-sync-history.ts --apply.`
      );
    }

    console.log('\n=== Resultado ===');
    if (problems.length === 0) {
      console.log('OK: nenhuma divergencia encontrada. Seguro prosseguir com a limpeza do OMS (com confirmacao explicita).');
    } else {
      console.log(`FALHOU: ${problems.length} problema(s) encontrado(s):`);
      for (const p of problems) console.log(' -', p);
    }

    process.exitCode = problems.length === 0 ? 0 : 1;
  } finally {
    await Promise.all([omsPool.end(), corePool.end()]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
