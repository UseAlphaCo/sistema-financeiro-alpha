import { Pool } from "pg";

import type { WorkerEnv } from "./config";

const CONNECTION_TIMEOUT_MILLIS = 10_000;
const STATEMENT_TIMEOUT_MILLIS = 30_000;

export function createOmsPool(env: WorkerEnv): Pool {
  return new Pool({
    connectionString: env.OMS_DB_URL,
    application_name: "alp-core-fin-sync-worker-oms",
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
