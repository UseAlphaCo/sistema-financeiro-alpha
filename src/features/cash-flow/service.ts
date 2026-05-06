import { getPrismaClient } from "@/core/db/prisma-client";
import { getDateRangeForPeriod, getPreviousPeriodRange } from "@/lib/date-utils";
import type {
  CashFlowBySource,
  CashFlowFilters,
  CashFlowPeriod,
  CashFlowSummary,
} from "@/features/cash-flow/types";

type AggregateRow = {
  source: string;
  type: string;
  total_cents: bigint | number;
  tx_count: bigint | number;
};

async function aggregateTransactions(
  start: Date,
  end: Date,
  extraFilters: { source?: string; categoryId?: string; paymentMethod?: string }
): Promise<AggregateRow[]> {
  const db = getPrismaClient();

  const conditions: string[] = [
    `"deletedAt" IS NULL`,
    `"status" IN ('approved', 'applied')`,
    `"occurredAt" >= $1`,
    `"occurredAt" <= $2`,
  ];

  const values: unknown[] = [start, end];

  if (extraFilters.source) {
    values.push(extraFilters.source);
    conditions.push(`"source" = $${values.length}`);
  }

  if (extraFilters.categoryId) {
    values.push(extraFilters.categoryId);
    conditions.push(`"categoryId" = $${values.length}`);
  }

  if (extraFilters.paymentMethod) {
    values.push(extraFilters.paymentMethod);
    conditions.push(`"paymentMethodNormalized" = $${values.length}`);
  }

  const sql = `
    SELECT source, type, SUM("amountCents") AS total_cents, COUNT(id) AS tx_count
    FROM "FinancialTransaction"
    WHERE ${conditions.join(" AND ")}
    GROUP BY source, type
  `;

  return db.$queryRawUnsafe<AggregateRow[]>(sql, ...values);
}

function toNumber(v: bigint | number): number {
  return typeof v === "bigint" ? Number(v) : v;
}

function buildSourceMap(rows: AggregateRow[]): Map<string, CashFlowBySource> {
  const map = new Map<string, CashFlowBySource>();

  for (const row of rows) {
    const src = row.source;
    if (!map.has(src)) {
      map.set(src, {
        source: src,
        grossCents: 0,
        feesCents: 0,
        netCents: 0,
        transactionCount: 0,
      });
    }
    const entry = map.get(src)!;
    const amount = toNumber(row.total_cents);
    const count = toNumber(row.tx_count);

    if (row.type === "income") {
      entry.grossCents += amount;
      entry.transactionCount += count;
    } else if (row.type === "expense") {
      entry.feesCents += amount;
      entry.transactionCount += count;
    }
    entry.netCents = entry.grossCents - entry.feesCents;
  }

  return map;
}

function sumTotals(rows: AggregateRow[]) {
  let income = 0;
  let expense = 0;

  for (const row of rows) {
    const amount = toNumber(row.total_cents);
    if (row.type === "income") income += amount;
    else if (row.type === "expense") expense += amount;
  }

  return { income, expense };
}

export async function computeCashFlow(
  filters: CashFlowFilters
): Promise<CashFlowSummary> {
  const days = filters.days ?? 30;
  const now = new Date();

  let start: Date;
  let end: Date;

  if (filters.startDate && filters.endDate) {
    start = new Date(filters.startDate);
    start.setHours(0, 0, 0, 0);
    end = new Date(filters.endDate);
    end.setHours(23, 59, 59, 999);
  } else {
    const range = getDateRangeForPeriod(days, now);
    start = range.start;
    end = range.end;
  }

  const periodDays = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;

  const extraFilters = {
    source: filters.source,
    categoryId: filters.categoryId,
    paymentMethod: filters.paymentMethod,
  };

  const [currentRows, prevRange] = await Promise.all([
    aggregateTransactions(start, end, extraFilters),
    Promise.resolve(getPreviousPeriodRange(start, periodDays)),
  ]);

  const prevRows = await aggregateTransactions(prevRange.start, prevRange.end, extraFilters);

  const sourceMap = buildSourceMap(currentRows);
  const { income: totalIncome, expense: totalExpense } = sumTotals(currentRows);
  const { income: prevIncome, expense: prevExpense } = sumTotals(prevRows);

  const period: CashFlowPeriod = {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    days: periodDays,
  };

  return {
    period,
    totalIncomeCents: totalIncome,
    totalExpenseCents: totalExpense,
    totalFeesCents: 0,
    netCents: totalIncome - totalExpense,
    bySource: Array.from(sourceMap.values()),
    previousPeriod: {
      totalIncomeCents: prevIncome,
      totalExpenseCents: prevExpense,
      netCents: prevIncome - prevExpense,
    },
  };
}
