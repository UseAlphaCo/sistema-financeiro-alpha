import { Pool } from "pg";

import type { WorkerEnv } from "./config";

export function createOmsPool(env: WorkerEnv): Pool {
  return new Pool({
    connectionString: env.OMS_DB_URL,
    application_name: "alp-core-fin-sync-worker-oms",
    max: 2,
  });
}

export function createCorePool(env: WorkerEnv): Pool {
  return new Pool({
    connectionString: env.CORE_DB_URL,
    application_name: "alp-core-fin-sync-worker-core",
    max: 2,
  });
}
