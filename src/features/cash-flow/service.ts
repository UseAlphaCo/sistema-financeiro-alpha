import { getPrismaClient } from "@/core/db/prisma-client";
import { getPaymentMethodSearchTokens } from "@/features/transactions/payment-method-filter";
import { normalizeMarketplaceToken } from "@/features/transactions/read-model-filters";
import { PAYMENT_METHODS, type PaymentMethod } from "@/features/transactions/types";
import { isMirrorReadModelEnabled } from "@/shared/read-model-config";
import {
  getDateRangeForPeriod,
  getDateRangeForPreset,
  getPreviousPeriodRange,
} from "@/lib/date-utils";
import { listFinancialReadModelTransactions } from "@/features/transactions/read-model";
import type {
  CashFlowByPaymentMethod,
  CashFlowBySource,
  CashFlowFilters,
  CashFlowPeriod,
  CashFlowSummary,
} from "@/features/cash-flow/types";

type AggregateRow = {
  source: string;
  payment_method: string | null;
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
  extraFilters: {
    source?: string;
    marketplace?: string;
    categoryId?: string;
    paymentMethod?: PaymentMethod;
  }
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

  if (extraFilters.marketplace) {
    values.push(extraFilters.marketplace);
    conditions.push(
      `REPLACE(REPLACE(LOWER(COALESCE(NULLIF("marketplace", ''), "externalSource", '')), ' ', '_'), '-', '_') = $${values.length}`
    );
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
      COALESCE(NULLIF("marketplace", ''), "source") AS source,
      COALESCE(NULLIF(CAST("paymentMethodNormalized" AS text), ''), 'other') AS payment_method,
      type,
      SUM("amountCents") AS total_cents,
      COUNT(id) AS tx_count
    FROM "FinancialTransaction"
    WHERE ${conditions.join(" AND ")}
    GROUP BY COALESCE(NULLIF(CAST("paymentMethodNormalized" AS text), ''), 'other'), COALESCE(NULLIF("marketplace", ''), "source"), type
  `;

  return db.$queryRawUnsafe<AggregateRow[]>(sql, ...values);
}

async function aggregateBreakdown(
  start: Date,
  end: Date,
  extraFilters: {
    source?: string;
    marketplace?: string;
    categoryId?: string;
    paymentMethod?: PaymentMethod;
  }
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

  if (extraFilters.marketplace) {
    values.push(extraFilters.marketplace);
    conditions.push(
      `REPLACE(REPLACE(LOWER(COALESCE(NULLIF("marketplace", ''), "externalSource", '')), ' ', '_'), '-', '_') = $${values.length}`
    );
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
        expenseCents: 0,
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
      entry.expenseCents += amount;
      entry.transactionCount += count;
    }
  }

  return map;
}

// NOTA: esta função NÃO classifica forma de pagamento a partir de texto bruto —
// ela apenas valida se um valor já normalizado (persistido em
// paymentMethodNormalized) é um PaymentMethod conhecido, retornando "other" caso
// contrário. A classificação raw -> PaymentMethod tem fonte única em
// classifyPaymentMethod() (src/features/transactions/payment-method-filter.ts).
function normalizePaymentMethodBucket(value: string | null | undefined): PaymentMethod {
  if (!value) return "other";

  return PAYMENT_METHODS.includes(value as PaymentMethod) ? (value as PaymentMethod) : "other";
}

function buildPaymentMethodMap(rows: AggregateRow[]): Map<string, CashFlowByPaymentMethod> {
  const map = new Map<string, CashFlowByPaymentMethod>();

  for (const row of rows) {
    if (row.type !== "income") {
      continue;
    }

    const method = normalizePaymentMethodBucket(row.payment_method);
    if (!map.has(method)) {
      map.set(method, {
        paymentMethod: method,
        grossCents: 0,
        transactionCount: 0,
      });
    }

    const entry = map.get(method)!;
    entry.grossCents += toNumber(row.total_cents);
    entry.transactionCount += toNumber(row.tx_count);
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

function shouldUseMirrorReadModel(): boolean {
  return isMirrorReadModelEnabled();
}

function summarizeTransactions(items: Array<{
  marketplace: string | null;
  externalSource: string | null;
  source: string;
  type: string;
  paymentMethodNormalized: string | null;
  amountCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  feeCents: number;
}>): {
  totalIncomeCents: number;
  totalExpenseCents: number;
  totalDiscountCents: number;
  totalShippingCents: number;
  totalTaxCents: number;
  bySource: CashFlowBySource[];
  byPaymentMethod: CashFlowByPaymentMethod[];
} {
  let totalIncomeCents = 0;
  let totalExpenseCents = 0;
  let totalDiscountCents = 0;
  let totalShippingCents = 0;
  let totalTaxCents = 0;

  const bySourceMap = new Map<string, CashFlowBySource>();
  const byPaymentMethodMap = new Map<string, CashFlowByPaymentMethod>();

  for (const item of items) {
    totalDiscountCents += item.discountCents;
    totalShippingCents += item.shippingCents;
    totalTaxCents += item.taxCents + item.feeCents;

    const paymentMethodKey = normalizePaymentMethodBucket(item.paymentMethodNormalized);
    if (!byPaymentMethodMap.has(paymentMethodKey)) {
      byPaymentMethodMap.set(paymentMethodKey, {
        paymentMethod: paymentMethodKey,
        grossCents: 0,
        transactionCount: 0,
      });
    }

    const paymentBucket = byPaymentMethodMap.get(paymentMethodKey)!;

    const sourceKey = item.marketplace ?? item.externalSource ?? item.source;
    if (!bySourceMap.has(sourceKey)) {
      bySourceMap.set(sourceKey, {
        source: sourceKey,
        grossCents: 0,
        expenseCents: 0,
        transactionCount: 0,
      });
    }

    const bucket = bySourceMap.get(sourceKey)!;
    bucket.transactionCount += 1;

    if (item.type === "income") {
      totalIncomeCents += item.amountCents;
      bucket.grossCents += item.amountCents;
      paymentBucket.grossCents += item.amountCents;
      paymentBucket.transactionCount += 1;
    } else if (item.type === "expense") {
      totalExpenseCents += item.amountCents;
      bucket.expenseCents += item.amountCents;
    }
  }

  const bySource = Array.from(bySourceMap.values());

  return {
    totalIncomeCents,
    totalExpenseCents,
    totalDiscountCents,
    totalShippingCents,
    totalTaxCents,
    bySource,
    byPaymentMethod: Array.from(byPaymentMethodMap.values()),
  };
}

// Extraida para testabilidade sem depender de banco: se so uma das pontas do
// range vier preenchida (ex.: usuario preencheu so "Data inicial"), a busca
// deve usar aquele dia, e nao cair silenciosamente no preset (que defaultava
// para "yesterday" e ignorava a data digitada).
export function resolveCashFlowDateRange(
  filters: Pick<CashFlowFilters, "startDate" | "endDate" | "preset" | "days">,
  now: Date
): { start: Date; end: Date } {
  if (filters.startDate || filters.endDate) {
    return {
      start: parseLocalIsoDate(filters.startDate ?? filters.endDate!),
      end: parseLocalIsoDate(filters.endDate ?? filters.startDate!, true),
    };
  }

  if (filters.preset) {
    return getDateRangeForPreset(filters.preset, now);
  }

  return getDateRangeForPeriod(filters.days ?? 30, now);
}

export async function computeCashFlow(
  filters: CashFlowFilters
): Promise<CashFlowSummary> {
  const now = new Date();
  const { start, end } = resolveCashFlowDateRange(filters, now);

  const periodDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const prevRange = getPreviousPeriodRange(start, periodDays);
  // `?? undefined` porque o read model devolve null para "sem filtro" ("todos",
  // "all", vazio) e o resto deste modulo trata ausencia como undefined.
  const marketplace = normalizeMarketplaceToken(filters.marketplace) ?? undefined;

  const extraFilters = {
    source: filters.source,
    marketplace,
    categoryId: filters.categoryId,
    paymentMethod: filters.paymentMethod,
  };

  if (shouldUseMirrorReadModel()) {
    const mirrorSourceFilters = filters.source
      ? { source: filters.source }
      : { sources: ["integration", "webhook"] };

    // Sequencial de proposito, nao Promise.all: o pool do CORE_DB_URL tem so
    // 2 conexoes (getCorePool em read-model.ts) e disparar as consultas do
    // periodo atual e anterior ao mesmo tempo contra esse pool causava falhas
    // intermitentes de conexao/estouro de statement_timeout neste ambiente
    // (reproduzido de forma consistente; a mesma query isolada roda em
    // ~300ms). Custo adicional aqui e' irrelevante (soma de duas consultas
    // rapidas), a instabilidade nao vale a pena.
    const currentItems = await listFinancialReadModelTransactions({
      ...extraFilters,
      ...mirrorSourceFilters,
      marketplace,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    });
    const previousItems = await listFinancialReadModelTransactions({
      ...extraFilters,
      ...mirrorSourceFilters,
      marketplace,
      startDate: prevRange.start.toISOString(),
      endDate: prevRange.end.toISOString(),
    });

    const current = summarizeTransactions(currentItems);
    const previous = summarizeTransactions(previousItems);

    const period: CashFlowPeriod = {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      days: periodDays,
      preset: filters.preset,
    };

    return {
      period,
      totalIncomeCents: current.totalIncomeCents,
      totalExpenseCents: current.totalExpenseCents,
      totalDiscountCents: current.totalDiscountCents,
      totalShippingCents: current.totalShippingCents,
      totalTaxCents: current.totalTaxCents,
      bySource: current.bySource,
      byPaymentMethod: current.byPaymentMethod,
      previousPeriod: {
        totalIncomeCents: previous.totalIncomeCents,
        totalExpenseCents: previous.totalExpenseCents,
        totalDiscountCents: previous.totalDiscountCents,
        totalShippingCents: previous.totalShippingCents,
        totalTaxCents: previous.totalTaxCents,
        byPaymentMethod: previous.byPaymentMethod,
      },
    };
  }

  const [currentRows, currentBreakdown] = await Promise.all([
    aggregateTransactions(start, end, extraFilters),
    aggregateBreakdown(start, end, extraFilters),
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
    totalDiscountCents: toNumber(currentBreakdown.total_discount_cents),
    totalShippingCents: toNumber(currentBreakdown.total_shipping_cents),
    totalTaxCents: toNumber(currentBreakdown.total_tax_cents),
    bySource: Array.from(sourceMap.values()),
    byPaymentMethod: Array.from(buildPaymentMethodMap(currentRows).values()),
    previousPeriod: {
      totalIncomeCents: prevIncome,
      totalExpenseCents: prevExpense,
      totalDiscountCents: toNumber(prevBreakdown.total_discount_cents),
      totalShippingCents: toNumber(prevBreakdown.total_shipping_cents),
      totalTaxCents: toNumber(prevBreakdown.total_tax_cents),
      byPaymentMethod: Array.from(buildPaymentMethodMap(prevRows).values()),
    },
  };
}
