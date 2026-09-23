import { beforeEach, describe, expect, it, vi } from "vitest";

const { repo, listCategoriesMock } = vi.hoisted(() => ({
  repo: {
    sumEntriesByType: vi.fn(),
    groupEntriesByCategory: vi.fn(),
    listEntriesPaginated: vi.fn(),
  },
  listCategoriesMock: vi.fn(),
}));

vi.mock("@/features/cash-flow/entries-repository", () => repo);
vi.mock("@/features/categories/repository", () => ({ listCategories: listCategoriesMock }));

// Isolamento estrutural: se algum caminho da tela de lancamentos chegar ao read
// model de marketplaces ou ao pool pg do mirror, o teste quebra no import.
vi.mock("@/features/transactions/read-model", () => {
  throw new Error("Fluxo de Caixa nao pode importar o read model de marketplaces");
});
vi.mock("pg", () => {
  throw new Error("Fluxo de Caixa nao pode abrir conexao pg");
});

import {
  buildCategoryBreakdown,
  computeCashFlowEntries,
  summarizeEntryTotals,
  UNCATEGORIZED_LABEL,
} from "@/features/cash-flow/entries-service";

// 15h UTC = 12h em Brasilia, dia 22/09.
const NOW = new Date("2026-09-22T15:00:00Z");

function lastRange(mock: ReturnType<typeof vi.fn>, call = 0) {
  const [range] = mock.mock.calls[call];
  return { start: range.start.toISOString(), end: range.end.toISOString() };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.sumEntriesByType.mockResolvedValue([]);
  repo.groupEntriesByCategory.mockResolvedValue([]);
  repo.listEntriesPaginated.mockResolvedValue({ items: [], total: 0 });
  listCategoriesMock.mockResolvedValue([]);
});

describe("computeCashFlowEntries - periodo", () => {
  it("dia inteiro de Brasilia: 03:00:00.000Z ate 02:59:59.999Z do dia seguinte", async () => {
    await computeCashFlowEntries({ startDate: "2026-09-10", endDate: "2026-09-10" }, NOW);
    expect(lastRange(repo.sumEntriesByType)).toEqual({
      start: "2026-09-10T03:00:00.000Z",
      end: "2026-09-11T02:59:59.999Z",
    });
  });

  it("so startDate traz aquele dia, nao cai no preset", async () => {
    await computeCashFlowEntries({ preset: "d30", startDate: "2026-09-10" }, NOW);
    expect(lastRange(repo.sumEntriesByType)).toEqual({
      start: "2026-09-10T03:00:00.000Z",
      end: "2026-09-11T02:59:59.999Z",
    });
  });

  it("ontem as 23h de Brasilia ja e dia seguinte em UTC, e ontem continua sendo o dia de Brasilia", async () => {
    // 02:00Z de 23/09 = 23h de 22/09 em Brasilia: ontem e 21/09.
    await computeCashFlowEntries({ preset: "yesterday" }, new Date("2026-09-23T02:00:00Z"));
    expect(lastRange(repo.sumEntriesByType)).toEqual({
      start: "2026-09-21T03:00:00.000Z",
      end: "2026-09-22T02:59:59.999Z",
    });
  });

  it("periodo anterior tem o mesmo tamanho e termina na vespera", async () => {
    await computeCashFlowEntries({ startDate: "2026-09-10", endDate: "2026-09-16" }, NOW);
    expect(lastRange(repo.sumEntriesByType, 1)).toEqual({
      start: "2026-09-03T03:00:00.000Z",
      end: "2026-09-10T02:59:59.999Z",
    });
  });

  it("repassa categoria e tipo para todas as consultas", async () => {
    await computeCashFlowEntries({ preset: "d7", categoryId: "cat-1", type: "expense" }, NOW);
    const filters = { categoryId: "cat-1", type: "expense" };
    expect(repo.sumEntriesByType.mock.calls[0][1]).toEqual(filters);
    expect(repo.sumEntriesByType.mock.calls[1][1]).toEqual(filters);
    expect(repo.groupEntriesByCategory.mock.calls[0][1]).toEqual(filters);
    expect(repo.listEntriesPaginated.mock.calls[0][1]).toEqual(filters);
  });
});

describe("computeCashFlowEntries - comparativo", () => {
  it("sem nenhum lancamento no periodo anterior e 'sem base' (null), nao zero", async () => {
    repo.sumEntriesByType
      .mockResolvedValueOnce([{ type: "income", totalCents: 10_000, count: 1 }])
      .mockResolvedValueOnce([]);
    const summary = await computeCashFlowEntries({ preset: "d7" }, NOW);
    expect(summary.previousTotals).toBeNull();
  });

  it("periodo anterior so com transferencia e base com totais zero, nao 'sem base'", async () => {
    repo.sumEntriesByType
      .mockResolvedValueOnce([{ type: "income", totalCents: 10_000, count: 1 }])
      .mockResolvedValueOnce([{ type: "transfer", totalCents: 5_000, count: 1 }]);
    const summary = await computeCashFlowEntries({ preset: "d7" }, NOW);
    expect(summary.previousTotals).toMatchObject({ incomeCents: 0, expenseCents: 0, transferCount: 1 });
  });
});

describe("computeCashFlowEntries - paginacao", () => {
  it("limite fora de 25/50/100 cai em 50; pagina invalida vira 1", async () => {
    await computeCashFlowEntries({ preset: "d7", page: -3, limit: 1000 }, NOW);
    expect(repo.listEntriesPaginated.mock.calls[0].slice(2)).toEqual([1, 50]);
  });

  it("ultima pagina nao tem proxima", async () => {
    repo.listEntriesPaginated.mockResolvedValue({ items: [], total: 50 });
    const summary = await computeCashFlowEntries({ preset: "d7", page: 2, limit: 25 }, NOW);
    expect(summary.pagination).toEqual({ page: 2, limit: 25, total: 50, hasNext: false });
  });

  it("pagina alem do total devolve vazio sem erro", async () => {
    repo.listEntriesPaginated.mockResolvedValue({ items: [], total: 3 });
    const summary = await computeCashFlowEntries({ preset: "d7", page: 999 }, NOW);
    expect(summary.items).toEqual([]);
    expect(summary.pagination.hasNext).toBe(false);
  });

  it("total zero", async () => {
    const summary = await computeCashFlowEntries({ preset: "d7" }, NOW);
    expect(summary.pagination).toEqual({ page: 1, limit: 50, total: 0, hasNext: false });
  });

  it("erro de banco sobe, nunca vira tela zerada", async () => {
    repo.sumEntriesByType.mockRejectedValue(new Error("connection refused"));
    await expect(computeCashFlowEntries({ preset: "d7" }, NOW)).rejects.toThrow("connection refused");
  });
});

describe("summarizeEntryTotals", () => {
  it("transferencia so conta, nao entra em entradas, saidas nem saldo", () => {
    const totals = summarizeEntryTotals([
      { type: "income", totalCents: 30_000, count: 2 },
      { type: "expense", totalCents: 12_000, count: 3 },
      { type: "transfer", totalCents: 99_999, count: 4 },
    ]);
    expect(totals).toEqual({
      incomeCents: 30_000,
      expenseCents: 12_000,
      balanceCents: 18_000,
      incomeCount: 2,
      expenseCount: 3,
      transferCount: 4,
    });
  });

  it("linha de marketplace injetada (source webhook ja filtrado no where) nao tem tipo proprio para vazar", () => {
    // O filtro de origem vive no where (ver entries-repository.test.ts); aqui a
    // garantia e que tipo desconhecido nunca soma.
    const totals = summarizeEntryTotals([{ type: "sale", totalCents: 50_000, count: 1 }]);
    expect(totals.incomeCents + totals.expenseCents + totals.balanceCents).toBe(0);
  });
});

describe("buildCategoryBreakdown", () => {
  const categories = [
    { id: "a", name: "Aluguel", color: "#f00" },
    { id: "b", name: "Bancos", color: null },
    { id: "v", name: "Vendas balcao", color: "#0f0" },
  ];

  it("separa entrada de saida, ordena por total e deixa 'Sem categoria' por ultimo", () => {
    const result = buildCategoryBreakdown(
      [
        { type: "expense", categoryId: null, totalCents: 90_000, count: 1 },
        { type: "expense", categoryId: "b", totalCents: 1_000, count: 1 },
        { type: "expense", categoryId: "a", totalCents: 9_000, count: 2 },
        { type: "income", categoryId: "v", totalCents: 5_000, count: 1 },
        { type: "transfer", categoryId: null, totalCents: 7_000, count: 1 },
      ],
      categories
    );
    expect(result.expense.map((row) => row.name)).toEqual(["Aluguel", "Bancos", UNCATEGORIZED_LABEL]);
    expect(result.income.map((row) => row.name)).toEqual(["Vendas balcao"]);
    expect(result.expense[0]).toMatchObject({ color: "#f00", count: 2, share: 0.09 });
  });

  it("empate de total desempata pelo nome", () => {
    const result = buildCategoryBreakdown(
      [
        { type: "expense", categoryId: "b", totalCents: 1_000, count: 1 },
        { type: "expense", categoryId: "a", totalCents: 1_000, count: 1 },
      ],
      categories
    );
    expect(result.expense.map((row) => row.categoryId)).toEqual(["a", "b"]);
  });

  it("soma das categorias bate com o total do tipo", () => {
    const rows = [
      { type: "income", categoryId: "v", totalCents: 5_000, count: 1 },
      { type: "income", categoryId: null, totalCents: 2_500, count: 1 },
    ];
    const result = buildCategoryBreakdown(rows, categories);
    const totals = summarizeEntryTotals([{ type: "income", totalCents: 7_500, count: 2 }]);
    expect(result.income.reduce((sum, row) => sum + row.totalCents, 0)).toBe(totals.incomeCents);
  });

  it("categoria apagada com lancamento continua no total", () => {
    const result = buildCategoryBreakdown(
      [{ type: "income", categoryId: "sumiu", totalCents: 1_000, count: 1 }],
      categories
    );
    expect(result.income[0]).toMatchObject({ categoryId: "sumiu", totalCents: 1_000 });
  });
});
