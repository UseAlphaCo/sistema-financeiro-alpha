import { Pool } from "pg";

import type { WorkerEnv } from "./config";

const CONNECTION_TIMEOUT_MILLIS = 10_000;
const STATEMENT_TIMEOUT_MILLIS = 30_000;

/**
 * O OMS e fonte de leitura. Nada neste repositorio deve escrever nele.
 *
 * A garantia e dada no startup da conexao, via parametro `options` do libpq:
 * toda transacao nasce READ ONLY, entao qualquer INSERT/UPDATE/DELETE/DDL
 * falha com "cannot execute ... in a read-only transaction" antes de tocar
 * dado. Vale inclusive para o fallback SYNC_CONTROL_TARGET=oms, que ainda
 * carrega metodos de escrita herdados do desenho antigo.
 *
 * Escolhido `options` em vez de "SET SESSION CHARACTERISTICS" no evento
 * `connect` do pool porque o pg nao aguarda listeners assincronos: uma query
 * poderia rodar antes do SET. O `options` e aplicado pelo servidor antes de
 * qualquer comando.
 *
 * Depende de session mode (porta 5432, a que OMS_DB_URL usa hoje). Ao migrar
 * para transaction mode (6543, item 1.5 do plano), revalidar: alguns poolers
 * ignoram `options`.
 */
export function createOmsPool(env: WorkerEnv): Pool {
  return new Pool({
    connectionString: env.OMS_DB_URL,
    application_name: "alp-core-fin-sync-worker-oms",
    options: "-c default_transaction_read_only=on",
    max: 2,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLIS,
    statement_timeout: STATEMENT_TIMEOUT_MILLIS,
    query_timeout: STATEMENT_TIMEOUT_MILLIS,
  });
}

export function createCorePool(env: WorkerEnv): Pool {
  return new Pool({
    connectionString: env.CORE_DB_URL,
    application_name: "alp-core-fin-sync-worker-core",
    max: 2,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLIS,
    statement_timeout: STATEMENT_TIMEOUT_MILLIS,
    query_timeout: STATEMENT_TIMEOUT_MILLIS,
  });
}
