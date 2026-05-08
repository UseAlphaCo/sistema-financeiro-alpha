import { getPrismaClient } from "@/core/db/prisma-client";
import { getPaymentMethodSearchTokens } from "@/features/transactions/payment-method-filter";
import type { PaymentMethod } from "@/features/transactions/types";
import {
  getDateRangeForPeriod,
  getDateRangeForPreset,
  getPreviousPeriodRange,
} from "@/lib/date-utils";
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

type BreakdownRow = {
  total_discount_cents: bigint | number;
  total_shipping_cents: bigint | number;
  total_tax_cents: bigint | number;
};

async function aggregateTransactions(
  start: Date,
  end: Date,
  extraFilters: { source?: string; categoryId?: string; paymentMethod?: PaymentMethod }
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
    const normalizedParam = `$${values.length}`;
    const tokenParams = getPaymentMethodSearchTokens(extraFilters.paymentMethod).map((token) => {
      values.push(`%${token}%`);
      return `"paymentMethodRaw" ILIKE $${values.length}`;
    });
    const rawCondition = tokenParams.length > 0 ? ` OR ${tokenParams.join(" OR ")}` : "";
    conditions.push(`("paymentMethodNormalized" = ${normalizedParam}${rawCondition})`);
  }

  const sql = `
    SELECT source, type, SUM("amountCents") AS total_cents, COUNT(id) AS tx_count
    FROM "FinancialTransaction"
    WHERE ${conditions.join(" AND ")}
    GROUP BY source, type
  `;

  return db.$queryRawUnsafe<AggregateRow[]>(sql, ...values);
}

async function aggregateBreakdown(
  start: Date,
  end: Date,
  extraFilters: { source?: string; categoryId?: string; paymentMethod?: PaymentMethod }
): Promise<BreakdownRow> {
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
    const normalizedParam = `$${values.length}`;
    const tokenParams = getPaymentMethodSearchTokens(extraFilters.paymentMethod).map((token) => {
      values.push(`%${token}%`);
      return `"paymentMethodRaw" ILIKE $${values.length}`;
    });
    const rawCondition = tokenParams.length > 0 ? ` OR ${tokenParams.join(" OR ")}` : "";
    conditions.push(`("paymentMethodNormalized" = ${normalizedParam}${rawCondition})`);
  }

  const sql = `
    SELECT
      COALESCE(SUM("discountCents"), 0) AS total_discount_cents,
      COALESCE(SUM("shippingCents"), 0) AS total_shipping_cents,
      COALESCE(SUM("taxCents") + SUM("feeCents"), 0) AS total_tax_cents
    FROM "FinancialTransaction"
    WHERE ${conditions.join(" AND ")}
  `;

  const rows = await db.$queryRawUnsafe<BreakdownRow[]>(sql, ...values);
  return (
    rows[0] ?? {
      total_discount_cents: 0,
      total_shipping_cents: 0,
      total_tax_cents: 0,
    }
  );
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

function parseLocalIsoDate(date: string, endOfDay = false): Date {
  const [year, month, day] = date.split("-").map(Number);
  const parsed = new Date(year, (month ?? 1) - 1, day ?? 1);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`invalid local date filter: ${date}`);
  }

  if (endOfDay) {
    parsed.setHours(23, 59, 59, 999);
  } else {
    parsed.setHours(0, 0, 0, 0);
  }

  return parsed;
}

export async function computeCashFlow(
  filters: CashFlowFilters
): Promise<CashFlowSummary> {
  const days = filters.days ?? 30;
  const now = new Date();

  let start: Date;
  let end: Date;

  if (filters.startDate && filters.endDate) {
    start = parseLocalIsoDate(filters.startDate);
    end = parseLocalIsoDate(filters.endDate, true);
  } else if (filters.preset) {
    const presetRange = getDateRangeForPreset(filters.preset, now);
    start = presetRange.start;
    end = presetRange.end;
  } else {
    const range = getDateRangeForPeriod(days, now);
    start = range.start;
    end = range.end;
  }

  const periodDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;

  const extraFilters = {
    source: filters.source,
    categoryId: filters.categoryId,
    paymentMethod: filters.paymentMethod,
  };

  const [currentRows, currentBreakdown, prevRange] = await Promise.all([
    aggregateTransactions(start, end, extraFilters),
    aggregateBreakdown(start, end, extraFilters),
    Promise.resolve(getPreviousPeriodRange(start, periodDays)),
  ]);

  const [prevRows, prevBreakdown] = await Promise.all([
    aggregateTransactions(prevRange.start, prevRange.end, extraFilters),
    aggregateBreakdown(prevRange.start, prevRange.end, extraFilters),
  ]);

  const sourceMap = buildSourceMap(currentRows);
  const { income: totalIncome, expense: totalExpense } = sumTotals(currentRows);
  const { income: prevIncome, expense: prevExpense } = sumTotals(prevRows);

  const period: CashFlowPeriod = {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
    days: periodDays,
    preset: filters.preset,
  };

  return {
    period,
    totalIncomeCents: totalIncome,
    totalExpenseCents: totalExpense,
    totalFeesCents: toNumber(currentBreakdown.total_tax_cents),
    totalDiscountCents: toNumber(currentBreakdown.total_discount_cents),
    totalShippingCents: toNumber(currentBreakdown.total_shipping_cents),
    totalTaxCents: toNumber(currentBreakdown.total_tax_cents),
    netCents: totalIncome - totalExpense,
    bySource: Array.from(sourceMap.values()),
    previousPeriod: {
      totalIncomeCents: prevIncome,
      totalExpenseCents: prevExpense,
      totalDiscountCents: toNumber(prevBreakdown.total_discount_cents),
      totalShippingCents: toNumber(prevBreakdown.total_shipping_cents),
      totalTaxCents: toNumber(prevBreakdown.total_tax_cents),
      netCents: prevIncome - prevExpense,
    },
  };
}
