import { describe, expect, it, vi } from "vitest";

const { configs } = vi.hoisted(() => ({ configs: [] as Record<string, unknown>[] }));

vi.mock("pg", () => ({
  Pool: class FakePool {
    constructor(config: Record<string, unknown>) {
      configs.push(config);
    }
  },
}));

import { createCorePool, createOmsPool } from "@/workers/sync/db";
import type { WorkerEnv } from "@/workers/sync/config";

const env = {
  OMS_DB_URL: "postgresql://oms",
  CORE_DB_URL: "postgresql://core",
  BATCH_SIZE: 100,
  MAX_RETRIES: 5,
  SYNC_CONTROL_TARGET: "core",
  DLQ_RETENTION_DAYS: 90,
  SYNC_WATERMARK_GRACE_SECONDS: 300,
} as WorkerEnv;

describe("pools de sincronizacao", () => {
  it("abre a conexao do OMS em transacao read-only", () => {
    configs.length = 0;
    createOmsPool(env);

    // Garantia estrutural: o OMS e fonte de leitura. Qualquer
    // INSERT/UPDATE/DELETE/DDL falha no servidor, inclusive pelos metodos de
    // escrita herdados que sobrevivem em OmsRepository para o fallback
    // SYNC_CONTROL_TARGET=oms.
    expect(configs[0]?.options).toBe("-c default_transaction_read_only=on");
  });

  it("nao restringe a conexao do CORE, que precisa escrever", () => {
    configs.length = 0;
    createCorePool(env);

    expect(configs[0]?.options).toBeUndefined();
  });
});
