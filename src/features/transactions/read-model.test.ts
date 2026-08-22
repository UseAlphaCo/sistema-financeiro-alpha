import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock, findManyMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  findManyMock: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class FakePool {
    query = queryMock;
    on = vi.fn();
    end = vi.fn();
    // `connect` existe porque as consultas passam por queryWithTimeout, que
    // pega uma conexao para aplicar `SET statement_timeout` -- o parametro do
    // construtor do Pool nao chega ao servidor atras do Supavisor. O SET cai no
    // mesmo queryMock, entao os testes de curto-circuito continuam contando
    // apenas as consultas que importam: o SET so aparece SE alguma consulta
    // acontecer, que e exatamente o que estes testes verificam.
    connect = vi.fn().mockResolvedValue({ query: queryMock, release: vi.fn() });
  },
}));

vi.mock("@/core/db/prisma-client", () => ({
  getPrismaClient: () => ({
    financialTransaction: { findMany: findManyMock },
  }),
}));

// Conexao presente de proposito: garante que o curto-circuito acontece pelos
// filtros, e nao por falta de CORE_DB_URL.
vi.mock("@/shared/read-model-config", () => ({
  getCoreConnectionString: () => "postgresql://core-de-teste",
  isMirrorReadModelEnabled: () => true,
  // Desligada: estes testes cobrem o curto-circuito do caminho do MIRROR. Com a
  // flag ligada o curto-circuito tambem vale, mas por outro caminho -- ver
  // listMaterializedTransactions, que chama o mesmo mirrorCannotContribute.
  isMaterializedReadModelEnabled: () => false,
  getMaterializedFloorDate: () => new Date("2026-08-01T00:00:00-03:00"),
}));

import {
  listFinancialReadModelPaginated,
  listMarketplaceReadModelPaginated,
} from "@/features/transactions/read-model";

describe("read-model: curto-circuito do mirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] });
    findManyMock.mockResolvedValue([]);
  });

  it("nao consulta o mirror quando a origem pedida e apenas manual (caso /lancamentos)", async () => {
    const result = await listFinancialReadModelPaginated({
      page: 1,
      limit: 20,
      source: "manual",
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });

  it("nao consulta o mirror quando sources nao inclui integration nem webhook", async () => {
    await listFinancialReadModelPaginated({
      page: 1,
      limit: 20,
      sources: ["manual", "import"],
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("nao consulta o mirror quando ha filtro por categoria", async () => {
    // Toda linha do mirror e mapeada com categoryId null.
    await listFinancialReadModelPaginated({
      page: 1,
      limit: 20,
      categoryId: "cat-1",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("nao consulta o mirror quando o tipo pedido nao e income", async () => {
    await listFinancialReadModelPaginated({
      page: 1,
      limit: 20,
      type: "expense",
    });

    expect(queryMock).not.toHaveBeenCalled();
  });

  it("consulta o mirror quando integration esta entre as origens pedidas", async () => {
    await listFinancialReadModelPaginated({
      page: 1,
      limit: 20,
      sources: ["manual", "integration"],
    });

    expect(queryMock).toHaveBeenCalled();
  });

  it("consulta o mirror quando nao ha filtro de origem", async () => {
    await listFinancialReadModelPaginated({ page: 1, limit: 20 });

    expect(queryMock).toHaveBeenCalled();
  });

  it("consulta o mirror na listagem de marketplace", async () => {
    await listMarketplaceReadModelPaginated({ page: 1, limit: 20 });

    expect(queryMock).toHaveBeenCalled();
  });
});
