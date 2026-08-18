import { describe, expect, it, vi } from "vitest";

import { OmsRepository } from "./oms-repository";

/**
 * O `options` do startup packet do Pool (ver db.ts) e ignorado pelo pooler
 * real (Supavisor) -- confirmado empiricamente contra o banco. A garantia
 * de read-only do OMS depende do SET explicito rodar antes de qualquer
 * outra query, na mesma conexao fisica (mesmo client). Estes testes travam
 * esse comportamento sem tocar em banco nenhum.
 */
function createMockClient(rows: unknown[] = []) {
  const query = vi.fn().mockImplementation((text: string) => {
    if (text === "SET default_transaction_read_only = on") {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.resolve({ rows, rowCount: rows.length });
  });

  return { query, release: vi.fn() };
}

describe("OmsRepository - guard de read-only", () => {
  it("roda o SET explicito antes de qualquer outra query, na mesma conexao", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await repo.findRawPayloadCandidates(30, 10);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "SET default_transaction_read_only = on");
    expect(client.query.mock.calls[1][0]).toContain("FROM raw_payloads");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("usa a mesma conexao para o SET e para findRawPayloadsAfter", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await repo.findRawPayloadsAfter({ sortAt: new Date(0), recordId: "" }, 10);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "SET default_transaction_read_only = on");
  });

  it("libera o client de volta ao pool mesmo quando a query falha", async () => {
    const client = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SET
        .mockRejectedValueOnce(new Error("boom")),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await expect(repo.findRawPayloadCandidates(30, 10)).rejects.toThrow("boom");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("cada chamada pega um client novo do pool (nao reusa conexao entre metodos)", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await repo.findRawPayloadCandidates(30, 10);
    await repo.findRawPayloadCandidates(60, 10);

    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
});
