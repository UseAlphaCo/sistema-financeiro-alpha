import { listCategories } from "@/features/categories/repository";
import { resolveCashFlowDateRange } from "@/features/cash-flow/period";
import {
  groupEntriesByCategory,
  listEntriesPaginated,
  sumEntriesByType,
  type EntriesCategoryRow,
  type EntriesTypeRow,
} from "@/features/cash-flow/entries-repository";
import type {
  CashFlowEntriesByCategory,
  CashFlowEntriesFilters,
  CashFlowEntriesSummary,
  CashFlowEntriesTotals,
} from "@/features/cash-flow/entries-types";
import { getPreviousPeriodRange } from "@/lib/date-utils";

export const ENTRIES_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_ENTRIES_PAGE_SIZE = 50;

type CategoryInfo = { id: string; name: string; color: string | null };

export const UNCATEGORIZED_LABEL = "Sem categoria";

/**
 * Totais a partir do agregado por tipo. Transferencia so e contada: nao entra
 * em Entradas, Saidas nem Saldo (move dinheiro entre contas, nao cria nem
 * consome caixa).
 */
export function summarizeEntryTotals(rows: EntriesTypeRow[]): CashFlowEntriesTotals {
  const totals: CashFlowEntriesTotals = {
    incomeCents: 0,
    expenseCents: 0,
    balanceCents: 0,
    incomeCount: 0,
    expenseCount: 0,
    transferCount: 0,
  };
  for (const row of rows) {
    if (row.type === "income") {
      totals.incomeCents += row.totalCents;
      totals.incomeCount += row.count;
    } else if (row.type === "expense") {
      totals.expenseCents += row.totalCents;
      totals.expenseCount += row.count;
    } else if (row.type === "transfer") {
      totals.transferCount += row.count;
    }
  }
  totals.balanceCents = totals.incomeCents - totals.expenseCents;
  return totals;
}

function hasAnyEntry(totals: CashFlowEntriesTotals): boolean {
  return totals.incomeCount + totals.expenseCount + totals.transferCount > 0;
}

/**
 * Quebra por categoria, separada em entrada e saida. Ordem determinista: total
 * desc, nome como desempate, "Sem categoria" sempre por ultimo. Categoria
 * apagada que ainda tem lancamento aparece pelo id, nao some do total.
 */
export function buildCategoryBreakdown(
  rows: EntriesCategoryRow[],
  categories: CategoryInfo[]
): CashFlowEntriesSummary["byCategory"] {
  const byId = new Map(categories.map((category) => [category.id, category]));

  const build = (type: "income" | "expense"): CashFlowEntriesByCategory[] => {
    const buckets = new Map<string | null, { totalCents: number; count: number }>();
    for (const row of rows) {
      if (row.type !== type) continue;
      const bucket = buckets.get(row.categoryId) ?? { totalCents: 0, count: 0 };
      bucket.totalCents += row.totalCents;
      bucket.count += row.count;
      buckets.set(row.categoryId, bucket);
    }

    const grandTotal = Array.from(buckets.values()).reduce((sum, b) => sum + b.totalCents, 0);

    return Array.from(buckets.entries())
      .map(([categoryId, bucket]) => {
        const info = categoryId ? byId.get(categoryId) : undefined;
        return {
          categoryId,
          name: categoryId ? info?.name ?? `Categoria removida (${categoryId})` : UNCATEGORIZED_LABEL,
          color: info?.color ?? null,
          totalCents: bucket.totalCents,
          count: bucket.count,
          share: grandTotal > 0 ? bucket.totalCents / grandTotal : 0,
        };
      })
      .sort((a, b) => {
        if ((a.categoryId === null) !== (b.categoryId === null)) {
          return a.categoryId === null ? 1 : -1;
        }
        if (b.totalCents !== a.totalCents) return b.totalCents - a.totalCents;
        return a.name.localeCompare(b.name, "pt-BR");
      });
  };

  return { income: build("income"), expense: build("expense") };
}

function normalizePaging(filters: CashFlowEntriesFilters) {
  const page = Math.max(1, Math.floor(filters.page ?? 1) || 1);
  const limit = (ENTRIES_PAGE_SIZES as readonly number[]).includes(filters.limit ?? 0)
    ? (filters.limit as number)
    : DEFAULT_ENTRIES_PAGE_SIZE;
  return { page, limit };
}

/**
 * Resumo da tela Fluxo de Caixa. `now` e parametro para teste de fronteira de
 * dia sem depender do relogio.
 */
export async function computeCashFlowEntries(
  filters: CashFlowEntriesFilters,
  now: Date = new Date()
): Promise<CashFlowEntriesSummary> {
  const range = resolveCashFlowDateRange(filters, now);
  const days = Math.floor((range.end.getTime() - range.start.getTime()) / 86_400_000) + 1;
  const previousRange = getPreviousPeriodRange(range.start, days);
  const { page, limit } = normalizePaging(filters);
  const whereFilters = { categoryId: filters.categoryId, type: filters.type };

  const [typeRows, previousTypeRows, categoryRows, list, categories] = await Promise.all([
    sumEntriesByType(range, whereFilters),
    sumEntriesByType(previousRange, whereFilters),
    groupEntriesByCategory(range, whereFilters),
    listEntriesPaginated(range, whereFilters, page, limit),
    listCategories(),
  ]);

  const previousTotals = summarizeEntryTotals(previousTypeRows);

  return {
    period: {
      startDate: range.start.toISOString(),
      endDate: range.end.toISOString(),
      days,
      preset: filters.preset,
    },
    totals: summarizeEntryTotals(typeRows),
    previousTotals: hasAnyEntry(previousTotals) ? previousTotals : null,
    byCategory: buildCategoryBreakdown(categoryRows, categories),
    items: list.items,
    pagination: { page, limit, total: list.total, hasNext: page * limit < list.total },
  };
}
