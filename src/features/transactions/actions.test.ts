import { beforeEach, describe, expect, it, vi } from "vitest";

const { repositoryMock, getCategoryByIdMock } = vi.hoisted(() => ({
  repositoryMock: {
    list: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  },
  getCategoryByIdMock: vi.fn(),
}));

vi.mock("@/features/transactions/repository", () => ({
  getTransactionsRepository: () => repositoryMock,
}));

vi.mock("@/features/categories/repository", () => ({
  getCategoryById: getCategoryByIdMock,
}));

import { createTransactionAction, updateTransactionAction } from "@/features/transactions/actions";

describe("transactions/actions category rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejeita criacao de income sem categoryId", async () => {
    const result = await createTransactionAction(
      {
        type: "income",
        amountCents: 1000,
        occurredAt: "2026-05-07T12:00:00.000Z",
        source: "manual",
        status: "approved",
      },
      "actor-1"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Categoria e obrigatoria");
    }
  });

  it("rejeita criacao com categoria incompativel", async () => {
    getCategoryByIdMock.mockResolvedValue({
      id: "cat-saida",
      name: "Impostos",
      direction: "saida",
    });

    const result = await createTransactionAction(
      {
        type: "income",
        categoryId: "cat-saida",
        amountCents: 1000,
        occurredAt: "2026-05-07T12:00:00.000Z",
        source: "manual",
        status: "approved",
      },
      "actor-1"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.toLowerCase()).toContain("incompat");
    }
  });

  it("cria lancamento quando categoria corresponde ao tipo", async () => {
    getCategoryByIdMock.mockResolvedValue({
      id: "cat-entrada",
      name: "Venda",
      direction: "entrada",
    });

    repositoryMock.create.mockResolvedValue({ id: "trx-1" });

    const result = await createTransactionAction(
      {
        type: "income",
        categoryId: "cat-entrada",
        amountCents: 1500,
        occurredAt: "2026-05-07T12:00:00.000Z",
        source: "manual",
        status: "approved",
      },
      "actor-1"
    );

    expect(result.success).toBe(true);
    expect(repositoryMock.create).toHaveBeenCalledTimes(1);
  });

  it("rejeita update que remove categoria de income", async () => {
    repositoryMock.findById.mockResolvedValue({
      id: "trx-1",
      type: "income",
    });

    const result = await updateTransactionAction(
      {
        id: "trx-1",
        categoryId: null,
      },
      "actor-1"
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Categoria e obrigatoria");
    }
  });
});
