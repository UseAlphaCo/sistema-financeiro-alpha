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
