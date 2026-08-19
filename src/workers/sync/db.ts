import { Pool } from "pg";

import type { WorkerEnv } from "./config";

const CONNECTION_TIMEOUT_MILLIS = 10_000;
const STATEMENT_TIMEOUT_MILLIS = 30_000;

/**
 * O OMS e fonte de leitura. Nada neste repositorio deve escrever nele.
 *
 * ATENCAO: o `options: -c default_transaction_read_only=on` abaixo e **defesa
 * em profundidade, nao a garantia**. Validado contra o pooler real em
 * 2026-08-18 (Supavisor, aws-*.pooler.supabase.com:5432): o startup packet do
 * libpq e **ignorado** -- `SHOW default_transaction_read_only` voltava "off" e
 * um UPDATE de teste NAO era rejeitado. Ate `application_name` chegava
 * sobrescrito como "Supavisor". Isso vale em 5432, nao e um risco exclusivo da
 * futura migracao para 6543 (item 1.5 do plano).
 *
 * A garantia real esta em `OmsRepository.query()`: `pool.connect()` + `SET
 * default_transaction_read_only = on` explicito na mesma conexao fisica, antes
 * de qualquer outra instrucao. Todo codigo novo que ler o OMS deve fazer o
 * mesmo -- ver tambem scripts/backfill-mirror-window.ts, que replica o padrao.
 *
 * `options` foi escolhido em vez de "SET SESSION CHARACTERISTICS" no evento
 * `connect` do pool porque o pg nao aguarda listeners assincronos: uma query
 * poderia rodar antes do SET.
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
