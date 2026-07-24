/**
 * Remove o trigger de captura de mudancas (CDC) no banco OMS que grava
 * automaticamente em integration.sync_events a cada INSERT/UPDATE/DELETE em
 * raw_payloads. Esse trigger e a causa raiz da inflacao continua do OMS:
 * ele roda de forma NATIVA no banco (nao faz parte do codigo deste repo) e
 * seguiria gravando mesmo com a aplicacao 100% migrada para controle no CORE.
 *
 * IMPORTANTE — OMS E COMPARTILHADO POR OUTROS SISTEMAS/TIMES:
 * Antes de aplicar, confirme com os demais consumidores do banco ALP-OMS que
 * ninguem mais depende de integration.sync_events sendo alimentada por esse
 * trigger. Este script NAO deve ser rodado sem esse alinhamento.
 *
 * O que este script faz:
 * 1. Mostra a definicao atual do trigger e da funcao (somente leitura).
 * 2. Em modo dry-run (padrao): apenas relata o que seria removido.
 * 3. Com --apply + env CONFIRM_OMS_TRIGGER_DROP=CONFIRMO-REMOCAO-TRIGGER-OMS:
 *    remove APENAS o trigger (`DROP TRIGGER trg_raw_payloads_sync ON raw_payloads`).
 *    A funcao `integration.capture_raw_payloads_changes()` NAO e removida por
 *    padrao (uso --drop-function para remove-la tambem, apos confirmar que
 *    nenhum outro trigger a utiliza).
 *
 * Uso:
 *   npx tsx scripts/disable-oms-sync-trigger.ts                      # dry-run
 *   CONFIRM_OMS_TRIGGER_DROP=CONFIRMO-REMOCAO-TRIGGER-OMS \
 *     npx tsx scripts/disable-oms-sync-trigger.ts --apply            # remove so o trigger
 *   CONFIRM_OMS_TRIGGER_DROP=CONFIRMO-REMOCAO-TRIGGER-OMS \
 *     npx tsx scripts/disable-oms-sync-trigger.ts --apply --drop-function
 */
import "dotenv/config";
import { Pool } from "pg";

const CONFIRM_PHRASE = "CONFIRMO-REMOCAO-TRIGGER-OMS";
const TRIGGER_NAME = "trg_raw_payloads_sync";
const TRIGGER_TABLE = "raw_payloads";
const FUNCTION_SCHEMA = "integration";
const FUNCTION_NAME = "capture_raw_payloads_changes";

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    apply: args.includes("--apply"),
    dropFunction: args.includes("--drop-function"),
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel de ambiente ${name} nao configurada.`);
  }
  return value;
}

async function describeCurrentState(pool: Pool) {
  const triggers = await pool.query<{ trigger_name: string; event_manipulation: string; action_statement: string }>(
    `
      SELECT trigger_name, event_manipulation, action_statement
      FROM information_schema.triggers
      WHERE event_object_table = $1 AND trigger_name = $2
    `,
    [TRIGGER_TABLE, TRIGGER_NAME]
  );

  const otherTriggersUsingFunction = await pool.query<{ trigger_name: string; event_object_table: string }>(
    `
      SELECT trigger_name, event_object_table
      FROM information_schema.triggers
      WHERE action_statement ILIKE $1 AND trigger_name <> $2
    `,
    [`%${FUNCTION_NAME}%`, TRIGGER_NAME]
  );

  return { triggers: triggers.rows, otherTriggersUsingFunction: otherTriggersUsingFunction.rows };
}

async function main() {
  const { apply, dropFunction } = parseArgs();
  const omsConnectionString = requireEnv("OMS_DB_URL");
  const pool = new Pool({ connectionString: omsConnectionString });

  console.log("disable-oms-sync-trigger", { mode: apply ? "APPLY" : "DRY-RUN", dropFunction });
  console.log(
    "\nATENCAO: OMS e compartilhado por outros sistemas/times. Confirme alinhamento antes de aplicar.\n"
  );

  try {
    const { triggers, otherTriggersUsingFunction } = await describeCurrentState(pool);

    console.log("=== Estado atual ===");
    if (triggers.length === 0) {
      console.log(`Trigger "${TRIGGER_NAME}" nao encontrado em "${TRIGGER_TABLE}" (ja removido ou nunca existiu).`);
    } else {
      console.log(`Trigger "${TRIGGER_NAME}" encontrado (${triggers.length} evento(s) associado(s)):`);
      for (const row of triggers) {
        console.log(` - ${row.event_manipulation}: ${row.action_statement}`);
      }
    }

    if (otherTriggersUsingFunction.length > 0) {
      console.log(
        `\nAVISO: ${otherTriggersUsingFunction.length} outro(s) trigger(s) tambem usam a funcao ${FUNCTION_SCHEMA}.${FUNCTION_NAME}:`
      );
      for (const row of otherTriggersUsingFunction) {
        console.log(` - ${row.trigger_name} em ${row.event_object_table}`);
      }
      if (dropFunction) {
        console.log(
          "Abortado: --drop-function nao pode ser usado enquanto outros triggers dependem dessa funcao."
        );
        process.exitCode = 1;
        return;
      }
    }

    if (triggers.length === 0) {
      console.log("\nNada a fazer.");
      return;
    }

    if (!apply) {
      console.log(
        `\nDRY-RUN: seria executado DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON ${TRIGGER_TABLE};` +
          (dropFunction ? ` e DROP FUNCTION IF EXISTS ${FUNCTION_SCHEMA}.${FUNCTION_NAME}();` : "")
      );
      console.log("Use --apply (com a env de confirmacao) para executar de fato.");
      return;
    }

    if (process.env.CONFIRM_OMS_TRIGGER_DROP !== CONFIRM_PHRASE) {
      console.error(
        `\nAbortado: defina CONFIRM_OMS_TRIGGER_DROP="${CONFIRM_PHRASE}" para confirmar esta acao.`
      );
      process.exitCode = 1;
      return;
    }

    console.log("\nRemovendo trigger no OMS...");
    await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME} ON ${TRIGGER_TABLE}`);
    console.log(`Trigger "${TRIGGER_NAME}" removido.`);

    if (dropFunction) {
      await pool.query(`DROP FUNCTION IF EXISTS ${FUNCTION_SCHEMA}.${FUNCTION_NAME}()`);
      console.log(`Funcao "${FUNCTION_SCHEMA}.${FUNCTION_NAME}" removida.`);
    }

    console.log("\nConcluido. integration.sync_events no OMS nao recebera mais gravacoes automaticas.");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
