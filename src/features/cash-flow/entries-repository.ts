import type { FinancialTransaction as DbTransaction, Prisma } from "@prisma/client";

import { getPrismaClient } from "@/core/db/prisma-client";
import type { FinancialTransaction, TransactionType } from "@/features/transactions/types";

/**
 * Leitura da tela Fluxo de Caixa: so Prisma, so lancamentos cadastrados.
 *
 * Nao importa `@/features/transactions/read-model` nem `pg`, e isso e o
 * isolamento: nenhum caminho daqui chega ao mirror ou a financial_orders, entao
 * venda de marketplace nao tem como aparecer nesta tela. Tambem nao reutiliza
 * `listPrismaTransactions` (read-model.ts), que nao filtra status, pagina em
 * memoria e engole erro de banco devolvendo lista vazia -- numa tela de
 * conferencia financeira isso viraria R$ 0,00. Aqui erro de banco sobe.
 */

export const ENTRY_SOURCES = ["manual", "import"] as const;
// Mesmo criterio de status do agregado da tela de Marketplaces
// (aggregateTransactions em service.ts). /lancamentos lista SEM filtro de status,
// e a diferenca e deliberada: pendente nao e dinheiro.
export const ENTRY_STATUSES = ["approved", "applied"] as const;

export type EntriesRange = { start: Date; end: Date };
export type EntriesWhereFilters = { categoryId?: string; type?: TransactionType };

/** Where canonico da tela. Pura e exportada: e o ponto de teste do isolamento. */
export function buildEntriesWhere(
  range: EntriesRange,
  filters: EntriesWhereFilters = {}
): Prisma.FinancialTransactionWhereInput {
  return {
    deletedAt: null,
    source: { in: [...ENTRY_SOURCES] },
    status: { in: [...ENTRY_STATUSES] },
    occurredAt: { gte: range.start, lte: range.end },
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
  };
}

export type EntriesTypeRow = { type: string; totalCents: number; count: number };
export type EntriesCategoryRow = {
  type: string;
  categoryId: string | null;
  totalCents: number;
  count: number;
};

export async function sumEntriesByType(
  range: EntriesRange,
  filters: EntriesWhereFilters
): Promise<EntriesTypeRow[]> {
  const rows = await getPrismaClient().financialTransaction.groupBy({
    by: ["type"],
    where: buildEntriesWhere(range, filters),
    _sum: { amountCents: true },
    _count: { _all: true },
  });
  return rows.map((row) => ({
    type: row.type,
    totalCents: row._sum.amountCents ?? 0,
    count: row._count._all,
  }));
}

export async function groupEntriesByCategory(
  range: EntriesRange,
  filters: EntriesWhereFilters
): Promise<EntriesCategoryRow[]> {
  const rows = await getPrismaClient().financialTransaction.groupBy({
    by: ["type", "categoryId"],
    where: buildEntriesWhere(range, filters),
    _sum: { amountCents: true },
    _count: { _all: true },
  });
  return rows.map((row) => ({
    type: row.type,
    categoryId: row.categoryId,
    totalCents: row._sum.amountCents ?? 0,
    count: row._count._all,
  }));
}

export async function listEntriesPaginated(
  range: EntriesRange,
  filters: EntriesWhereFilters,
  page: number,
  limit: number
): Promise<{ items: FinancialTransaction[]; total: number }> {
  const prisma = getPrismaClient();
  const where = buildEntriesWhere(range, filters);
  const [total, rows] = await Promise.all([
    prisma.financialTransaction.count({ where }),
    prisma.financialTransaction.findMany({
      where,
      // `id` desempata lancamentos no mesmo instante: sem ele a paginacao pode
      // repetir ou pular linha entre paginas.
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return { items: rows.map(toEntry), total };
}

function toEntry(row: DbTransaction): FinancialTransaction {
  return {
    id: row.id,
    externalSource: row.externalSource,
    externalId: row.externalId,
    marketplace: row.marketplace,
    orderNumber: row.orderNumber,
    paymentMethodRaw: row.paymentMethodRaw,
    paymentMethodNormalized:
      (row.paymentMethodNormalized as FinancialTransaction["paymentMethodNormalized"]) ?? null,
    shippingCents: row.shippingCents ?? 0,
    discountCents: row.discountCents ?? 0,
    taxCents: row.taxCents ?? 0,
    feeCents: row.feeCents ?? 0,
    liquidCents: row.amountCents,
    type: row.type as FinancialTransaction["type"],
    categoryId: row.categoryId,
    amountCents: row.amountCents,
    currency: row.currency,
    occurredAt: row.occurredAt.toISOString(),
    description: row.description,
    source: row.source as FinancialTransaction["source"],
    status: row.status as FinancialTransaction["status"],
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    changeReason: row.changeReason,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
