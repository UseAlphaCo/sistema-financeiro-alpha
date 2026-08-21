import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { getWorkerEnv } from "@/workers/sync/config";

const KEYS = ["OMS_DB_URL", "CORE_DB_URL", "SYNC_MIRROR_FLOOR_AT"] as const;

describe("piso de data na configuracao do worker", () => {
  const original = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      original.set(key, process.env[key]);
    }
    process.env.OMS_DB_URL = "postgresql://oms";
    process.env.CORE_DB_URL = "postgresql://core";
  });

  afterEach(() => {
    for (const [key, value] of original) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("usa o piso de agosto quando a variavel nao esta definida", () => {
    // O default e o PISO, nao "sem piso": se a variavel faltar em producao, a
    // falha segura e nao rebaixar as 604 mil linhas pre-agosto do OMS.
    delete process.env.SYNC_MIRROR_FLOOR_AT;

    expect(getWorkerEnv().SYNC_MIRROR_FLOOR_AT.toISOString()).toBe("2026-08-01T03:00:00.000Z");
  });

  it("aceita piso vindo do ambiente", () => {
    process.env.SYNC_MIRROR_FLOOR_AT = "2026-09-01T00:00:00-03:00";

    expect(getWorkerEnv().SYNC_MIRROR_FLOOR_AT.toISOString()).toBe("2026-09-01T03:00:00.000Z");
  });

  it("lanca em vez de aceitar data invalida", () => {
    // Nao e preciosismo: um piso NaN faria toda comparacao ser falsa, nenhuma
    // linha seria elegivel e o mirror pararia de crescer SEM ERRO -- pior que o
    // problema que o piso resolve.
    process.env.SYNC_MIRROR_FLOOR_AT = "ontem";

    let caught: unknown;
    try {
      getWorkerEnv();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ZodError);
    expect((caught as ZodError).issues.map((issue) => issue.path.join("."))).toContain(
      "SYNC_MIRROR_FLOOR_AT"
    );
  });
});
