import { getPrismaClient } from "@/core/db/prisma-client";
import { classifyPaymentMethod, getPaymentMethodSearchTokens } from "@/features/transactions/payment-method-filter";
import { canCompare, resolveCoverage } from "@/features/transactions/read-model-coverage";
import { normalizeMarketplaceToken } from "@/features/transactions/read-model-filters";
import { PAYMENT_METHODS, type PaymentMethod } from "@/features/transactions/types";
import { isMirrorReadModelEnabled, isShopifyPaymentsBasisEnabled } from "@/shared/read-model-config";
import {
  endOfZonedDay,
  getDateRangeForPeriod,
  getDateRangeForPreset,
  getPreviousPeriodRange,
  startOfZonedDay,
  zonedDayKey,
} from "@/lib/date-utils";
import {
  listFinancialReadModelTransactions,
  listShopifyGatewayPaymentsInWindow,
  type ShopifyGatewayPayment,
} from "@/features/transactions/read-model";
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
        basis: "orders",
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

/**
 * Fronteira do filtro de data, sempre no dia de calendario de Brasilia.
 *
 * Construia a data com `new Date(ano, mes, dia)` + `setHours`, que resolve no
 * fuso do processo -- correto na maquina local, deslocado em 3 h na Vercel
 * (UTC). Ver o cabecalho de src/lib/date-utils.ts.
 *
 * Aceita as duas formas que o schema de actions.ts permite: `YYYY-MM-DD` e ISO
 * completo. O caminho ISO existia so no papel -- `"2026-08-24T00:00:00Z"` caia
 * em `Number("24T00:00:00Z")` = NaN e a funcao lancava.
 */
function parseLocalIsoDate(date: string, endOfDay = false): Date {
  const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : (() => {
        const instant = new Date(date);
        if (Number.isNaN(instant.getTime())) {
          throw new Error(`invalid local date filter: ${date}`);
        }
        return zonedDayKey(instant);
      })();

  const boundary = endOfDay ? endOfZonedDay(dayKey) : startOfZonedDay(dayKey);

  if (Number.isNaN(boundary.getTime())) {
    throw new Error(`invalid local date filter: ${date}`);
  }

  return boundary;
}

function shouldUseMirrorReadModel(): boolean {
  return isMirrorReadModelEnabled();
}

/** Rotulo de origem da linha Shopify quando nao ha nenhum pedido materializado. */
const SHOPIFY_SOURCE_LABEL = "Shopify";

// Exportada para testabilidade sem depender de banco (mesmo motivo de
// resolveCashFlowDateRange abaixo): a troca da base da Shopify (de pedidos
// para pagamentos) precisa de um teste que prove que as outras origens nao
// mudam, e mockar o read model inteiro so pra isso seria mais fragil que
// testar a funcao pura direto.
export function summarizeTransactions(
  items: Array<{
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
  }>,
  /**
   * Pagamentos Shopify por gateway na janela, vindos do ledger de rateio.
   *
   * Quando presente, a Shopify troca de base: a linha dela em bySource e a
   * parte dela em byPaymentMethod passam a ser "pagamentos processados"
   * (uma entrada por perna de pagamento, datada pelo processed_at daquela
   * perna) em vez de "pedidos pagos". E o que faz o numero fechar com o
   * relatorio "Pagamentos brutos por gateway" da Shopify.
   *
   * As demais origens seguem intocadas, somando integration.financial_orders.
   */
  shopifyPayments?: ShopifyGatewayPayment[] | null
): {
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

  // Quando a Shopify vem do ledger de pagamentos, os pedidos dela nao entram
  // mais nestas somas — entrariam em duplicidade, e numa base diferente.
  // Descontos, frete e impostos continuam vindo do pedido: sao atributos do
  // pedido, nao do pagamento, e nao aparecem no relatorio da Shopify.
  //
  // Ledger vazio NAO significa "nao houve pagamento": significa, quase sempre,
  // que o job de resolucao ainda nao cobriu esta janela. Trocar de base nesse
  // caso apagaria a Shopify da tela, e vazio na tela le-se como "nao vendemos
  // nada". Entao so troca quando ha rateio de verdade; senao, cai na base de
  // pedidos, que e o comportamento de sempre.
  const shopifyPeloLedger = Boolean(shopifyPayments && shopifyPayments.length > 0);
  let shopifySourceKey: string | null = null;

  for (const item of items) {
    totalDiscountCents += item.discountCents;
    totalShippingCents += item.shippingCents;
    totalTaxCents += item.taxCents + item.feeCents;

    const ehPedidoShopify = item.externalSource === "shopify" && item.type === "income";
    if (shopifyPeloLedger && ehPedidoShopify) {
      shopifySourceKey ??= item.marketplace ?? item.externalSource ?? item.source;
      continue;
    }

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
        basis: "orders",
      });
    }

    const bucket = bySourceMap.get(sourceKey)!;
    bucket.transactionCount += 1;

    if (item.type === "income") {
      totalIncomeCents += item.amountCents;
      bucket.grossCents += item.amountCents;
      // Uma linha do read model = um pedido. Para estas origens "Transacoes"
      // continua sendo contagem de PEDIDOS.
      paymentBucket.transactionCount += 1;
      paymentBucket.grossCents += item.amountCents;
    } else if (item.type === "expense") {
      totalExpenseCents += item.amountCents;
      bucket.expenseCents += item.amountCents;
    }
  }

  if (shopifyPeloLedger && shopifyPayments) {
    const shopifyBucket: CashFlowBySource = {
      source: shopifySourceKey ?? SHOPIFY_SOURCE_LABEL,
      grossCents: 0,
      expenseCents: 0,
      transactionCount: 0,
      basis: "payments",
    };

    for (const pagamento of shopifyPayments) {
      totalIncomeCents += pagamento.amountCents;
      shopifyBucket.grossCents += pagamento.amountCents;
      shopifyBucket.transactionCount += pagamento.transactionCount;

      const methodKey = classifyPaymentMethod(pagamento.gatewayRaw);
      if (!byPaymentMethodMap.has(methodKey)) {
        byPaymentMethodMap.set(methodKey, {
          paymentMethod: methodKey,
          grossCents: 0,
          transactionCount: 0,
        });
      }
      const methodBucket = byPaymentMethodMap.get(methodKey)!;
      methodBucket.grossCents += pagamento.amountCents;
      methodBucket.transactionCount += pagamento.transactionCount;
    }

    bySourceMap.set(shopifyBucket.source, shopifyBucket);
  }

  // Maior primeiro: sem ordenar, a linha da Shopify (montada depois do laco)
  // cairia sempre no fim da tabela, abaixo de marketplaces muito menores.
  const bySource = Array.from(bySourceMap.values()).sort((a, b) => b.grossCents - a.grossCents);

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
    // A Shopify so troca de base quando esta de fato em escopo. Com um filtro
    // de origem ou de outro marketplace ativo, somar o ledger inteiro
    // acrescentaria uma linha Shopify que o usuario pediu para nao ver.
    const shopifyEmEscopo =
      isShopifyPaymentsBasisEnabled() &&
      !filters.source &&
      (marketplace === undefined || marketplace === "shopify");
    const filtrarPorForma = (pagamentos: ShopifyGatewayPayment[]) =>
      filters.paymentMethod
        ? pagamentos.filter((pagamento) => classifyPaymentMethod(pagamento.gatewayRaw) === filters.paymentMethod)
        : pagamentos;

    /**
     * So usa o ledger quando ele cobre a janela INTEIRA.
     *
     * O ledger e populado por backfill, um periodo por vez. Numa janela de 30
     * dias com rateio de 3, a soma sairia parecendo certa e representando um
     * decimo do periodo — sem erro, sem aviso, so um numero menor. E a mesma
     * classe de defeito de "vazio na tela le-se como nao vendemos nada", so que
     * mais dificil de perceber, porque o numero nao e zero.
     *
     * Falta um dia? Cai inteiro na base de pedidos. Preferimos a base antiga
     * completa a uma base nova pela metade.
     */
    const carregarPagamentos = async (janelaInicio: Date, janelaFim: Date, diasEsperados: number) => {
      const { pagamentos, diasCobertos } = await listShopifyGatewayPaymentsInWindow(janelaInicio, janelaFim);
      if (pagamentos.length === 0 || diasCobertos < diasEsperados) return null;
      return filtrarPorForma(pagamentos);
    };

    const currentShopifyPayments = shopifyEmEscopo ? await carregarPagamentos(start, end, periodDays) : null;

    // Base de comparacao so existe se o periodo anterior estiver INTEIRO acima
    // do piso de cobertura. Sem este teste o periodo anterior devolve zero e a
    // tela mostra "— vs periodo anterior" em verde: um zero fabricado que se le
    // como "sem variacao", e nao como "sem base". Nao e caso de borda -- o piso
    // e 01/08 e getPreviousPeriodRange cai inteiro abaixo dele para qualquer
    // periodo acima de ~10 dias, incluindo o preset default do dashboard.
    // Medido em 2026-08-24: 01-22/08 devolvia previousPeriod.totalIncomeCents=0
    // contra R$ 11.881.851,28 do periodo atual.
    //
    // So neste ramo: o piso descreve quando o dado do mirror comeca, e o ramo
    // de baixo agrega FinancialTransaction, cujo historico e independente do
    // truncamento do mirror.
    const previousCoverage = resolveCoverage(prevRange.start, prevRange.end);
    const previousItems = canCompare(previousCoverage)
      ? await listFinancialReadModelTransactions({
          ...extraFilters,
          ...mirrorSourceFilters,
          marketplace,
          startDate: prevRange.start.toISOString(),
          endDate: prevRange.end.toISOString(),
        })
      : null;
    const previousShopifyPayments =
      previousItems && shopifyEmEscopo
        ? await carregarPagamentos(prevRange.start, prevRange.end, periodDays)
        : null;

    const current = summarizeTransactions(currentItems, currentShopifyPayments);
    const previous = previousItems ? summarizeTransactions(previousItems, previousShopifyPayments) : null;

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
      previousPeriod: previous
        ? {
            totalIncomeCents: previous.totalIncomeCents,
            totalExpenseCents: previous.totalExpenseCents,
            totalDiscountCents: previous.totalDiscountCents,
            totalShippingCents: previous.totalShippingCents,
            totalTaxCents: previous.totalTaxCents,
            byPaymentMethod: previous.byPaymentMethod,
          }
        : null,
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
