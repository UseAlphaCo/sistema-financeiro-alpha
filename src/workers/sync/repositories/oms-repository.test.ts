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

    await repo.findKeysInPageRange(0, 10);

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

    await expect(repo.findKeysInPageRange(0, 10)).rejects.toThrow("boom");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["getHeapState", (repo: OmsRepository) => repo.getHeapState()],
    ["findKeysInPageRange", (repo: OmsRepository) => repo.findKeysInPageRange(0, 1000)],
    ["findRawPayloadsByIds", (repo: OmsRepository) => repo.findRawPayloadsByIds(["a"])],
  ])("aplica o guard de read-only tambem em %s", async (_name, call) => {
    const client = createMockClient([{ relfilenode: "1", heap_blocks: "10" }]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await call(repo);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenNthCalledWith(1, "SET default_transaction_read_only = on");
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  /**
   * Um LIMIT aqui, seguido do avanco do cursor para o fim da faixa, descartaria
   * o resto das paginas em silencio -- um buraco periodico, indistinguivel de
   * ruido nas metricas. A fronteira de chunk e sempre a pagina, nunca a linha.
   */
  it("a descoberta por faixa de paginas nao usa LIMIT e delimita por ctid", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await repo.findKeysInPageRange(1000, 2000);

    const [sql, params] = client.query.mock.calls[1];
    expect(sql).not.toMatch(/\bLIMIT\b/i);
    expect(sql).toContain("ctid >= $1::tid");
    expect(sql).toContain("ctid < $2::tid");
    expect(params).toEqual(["(1000,0)", "(2000,0)"]);
  });

  it("a descoberta nao traz payload_json nem headers_json (evita o TOAST)", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await repo.findKeysInPageRange(0, 10);

    const [sql] = client.query.mock.calls[1];
    expect(sql).not.toContain("payload_json");
    expect(sql).not.toContain("headers_json");
  });

  it("faixa vazia nao vai ao banco", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await expect(repo.findKeysInPageRange(500, 500)).resolves.toEqual([]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("cada chamada pega um client novo do pool (nao reusa conexao entre metodos)", async () => {
    const client = createMockClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    const repo = new OmsRepository(pool as never);

    await repo.findKeysInPageRange(0, 10);
    await repo.findRawPayloadsByIds(["a"]);

    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
});
