/**
 * Verificacao de valores: Sistema Financeiro vs Shopify (v1).
 *
 * Logica pura compartilhada entre o script CLI (scripts/verify-shopify-values.ts)
 * e a rota de checagem automatizada (/api/internal/cron/shopify-verify).
 *
 * Compara, para um dia especifico, o que o Fluxo de Caixa do Sistema
 * Financeiro mostra (faturamento bruto e numero de transacoes/pedidos)
 * contra o que a Shopify realmente processou naquele dia, via API real.
 *
 * Lado Sistema Financeiro: chama computeCashFlow() diretamente — a mesma
 * funcao que alimenta a tela /financeiro/fluxo-de-caixa.
 *
 * Lado Shopify: reusa a metodologia validada em
 * docs/shopify/shopify-payments-by-gateway.md (tenderTransactions + REST
 * orders/{id}/transactions.json, filtrado por transaction.processed_at, kind
 * sale/capture/change, status success).
 *
 * "Transacoes" aqui = pedidos pagos (nao eventos de pagamento da Shopify).
 */

import { computeCashFlow } from "@/features/cash-flow/service";
import { getCorePool, withConnectionRetry } from "@/features/transactions/read-model";

import { fetchShopifyOrderTransactions, type ShopifyOrderTransaction } from "./shopify-order-transactions";
import { normalizeShopifyStoreDomain, stripWrappingQuotes } from "./shopify-orders-sync";

const GROSS_KINDS = new Set(["sale", "capture", "change"]);
const SUCCESS_STATUS = "success";

export const VERIFICATION_TIMEZONE = "America/Bahia";

// Sinal de maturidade: so consideramos um dia "assentado" o suficiente para
// disparar alerta real (em vez de log informativo) quando ja se passaram
// horas suficientes desde a virada do dia local E a maior parte dos pedidos
// do dia ja teve o gateway de pagamento resolvido. Ver investigacao no plano
// de 2026-07-27: divergencia de manha (~6,5%/4,5%) convergiu para ~0,5% mais
// tarde no mesmo dia por causa desses dois lags de completude (sync do
// mirror + job de resolucao de gateway), nao por dado incorreto.
const MATURITY_MIN_HOURS_SINCE_WINDOW_END = 12;
const MATURITY_MIN_RESOLVED_RATIO = 0.95;

export type VerificationMetric = {
  label: string;
  financeiro: string;
  shopify: string;
  diff: string;
  diffPct: string;
  diverges: boolean;
};

export type SyncFreshness = {
  mirrorOrders: number;
  unresolvedOrders: number;
};

export type MaturitySignal = {
  hoursSinceWindowEnd: number;
  resolvedRatio: number;
  isMature: boolean;
};

export type VerificationReport = {
  date: string;
  timezone: string;
  windowUtc: { start: string; endExclusive: string };
  metrics: VerificationMetric[];
  syncFreshness: SyncFreshness;
  maturity: MaturitySignal;
  shopifyCandidateOrders: number;
};

export type VerificationOptions = {
  date?: string;
  toleranceCents?: number;
  concurrency?: number;
};

export async function buildVerificationReport(options: VerificationOptions = {}): Promise<VerificationReport> {
  const toleranceCents = options.toleranceCents ?? 1;
  const concurrency = options.concurrency ?? 5;
  const date = options.date ?? yesterdayInTimeZone(VERIFICATION_TIMEZONE);
  const window = dayWindowUtc(date, VERIFICATION_TIMEZONE);

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");
  if (!storeDomain) throw new Error("SHOPIFY_STORE_URL ausente ou invalido.");
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN ausente.");

  const [financeiro, shopify, freshness] = await Promise.all([
    computeCashFlow({ startDate: date, endDate: date, marketplace: "Shopify" }),
    loadShopifySide(storeDomain, accessToken, date, window, concurrency),
    loadSyncFreshness(window),
  ]);

  const financeiroSource = financeiro.bySource.find((entry) => entry.source === "Shopify");
  const financeiroGrossCents = financeiroSource?.grossCents ?? 0;
  const financeiroOrderCount = financeiroSource?.transactionCount ?? 0;

  return {
    date,
    timezone: VERIFICATION_TIMEZONE,
    windowUtc: { start: window.start.toISOString(), endExclusive: window.end.toISOString() },
    metrics: [
      buildMetric("Faturamento bruto", financeiroGrossCents, shopify.grossCents, toleranceCents, formatMoney),
      buildMetric(
        "Nº de transações (pedidos pagos)",
        financeiroOrderCount,
        shopify.orderCount,
        0,
        (value) => String(value)
      ),
    ],
    syncFreshness: freshness,
    maturity: computeMaturity(window, freshness),
    shopifyCandidateOrders: shopify.candidateOrders,
  };
}

function computeMaturity(window: { start: Date; end: Date }, freshness: SyncFreshness): MaturitySignal {
  const hoursSinceWindowEnd = (Date.now() - window.end.getTime()) / (1000 * 60 * 60);
  const resolvedRatio =
    freshness.mirrorOrders === 0 ? 1 : 1 - freshness.unresolvedOrders / freshness.mirrorOrders;

  return {
    hoursSinceWindowEnd,
    resolvedRatio,
    isMature:
      hoursSinceWindowEnd >= MATURITY_MIN_HOURS_SINCE_WINDOW_END && resolvedRatio >= MATURITY_MIN_RESOLVED_RATIO,
  };
}

function buildMetric(
  label: string,
  financeiroValue: number,
  shopifyValue: number,
  toleranceCents: number,
  format: (value: number) => string
): VerificationMetric {
  const diff = financeiroValue - shopifyValue;
  const diffPct = shopifyValue !== 0 ? (diff / shopifyValue) * 100 : financeiroValue === 0 ? 0 : 100;

  return {
    label,
    financeiro: format(financeiroValue),
    shopify: format(shopifyValue),
    diff: format(diff),
    diffPct: `${diffPct.toFixed(2)}%`,
    diverges: Math.abs(diff) > toleranceCents,
  };
}

type ShopifySide = {
  grossCents: number;
  orderCount: number;
  candidateOrders: number;
};

async function loadShopifySide(
  storeDomain: string,
  accessToken: string,
  date: string,
  window: { start: Date; end: Date },
  concurrency: number
): Promise<ShopifySide> {
  const orderIds = await loadTenderTransactionOrderIds(storeDomain, accessToken, date, window);
  const transactions = await loadOrderTransactions(storeDomain, accessToken, [...orderIds], window, concurrency);

  const grossByOrder = new Map<string, number>();
  for (const { orderId, transaction } of transactions) {
    if (transaction.status !== SUCCESS_STATUS) continue;
    if (!GROSS_KINDS.has(transaction.kind)) continue;
    grossByOrder.set(orderId, (grossByOrder.get(orderId) ?? 0) + transaction.amountCents);
  }

  const grossCents = [...grossByOrder.values()].reduce((sum, value) => sum + value, 0);

  return {
    grossCents,
    orderCount: grossByOrder.size,
    candidateOrders: orderIds.size,
  };
}

type TenderTransactionsResponse = {
  tenderTransactions: {
    edges: Array<{ node: { processedAt: string; order: { legacyResourceId: string } | null } }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
};

async function loadTenderTransactionOrderIds(
  storeDomain: string,
  accessToken: string,
  date: string,
  window: { start: Date; end: Date }
): Promise<Set<string>> {
  const query = `
    query TenderTransactions($first: Int!, $after: String, $query: String!) {
      tenderTransactions(first: $first, after: $after, query: $query) {
        edges {
          node {
            processedAt
            order { legacyResourceId }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const searchQuery = `processed_at:>=${date} processed_at:<=${nextDate(date)}`;
  const ids = new Set<string>();
  let after: string | undefined;

  do {
    const data = await shopifyGraphql(storeDomain, accessToken, query, { first: 250, after, query: searchQuery });
    const connection = data.tenderTransactions;
    for (const edge of connection.edges) {
      const processedAt = new Date(edge.node.processedAt);
      const orderId = edge.node.order?.legacyResourceId;
      if (processedAt >= window.start && processedAt < window.end && orderId) {
        ids.add(String(orderId));
      }
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return ids;
}

async function loadOrderTransactions(
  storeDomain: string,
  accessToken: string,
  orderIds: string[],
  window: { start: Date; end: Date },
  concurrency: number
): Promise<Array<{ orderId: string; transaction: ShopifyOrderTransaction }>> {
  const results: Array<{ orderId: string; transaction: ShopifyOrderTransaction }> = [];
  let index = 0;

  async function worker() {
    while (index < orderIds.length) {
      const orderId = orderIds[index++];
      const transactions = await fetchShopifyOrderTransactions(storeDomain, accessToken, orderId);
      for (const transaction of transactions) {
        if (!transaction.processedAt) continue;
        const processedAt = new Date(transaction.processedAt);
        if (processedAt < window.start || processedAt >= window.end) continue;
        results.push({ orderId, transaction });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}

async function loadSyncFreshness(window: { start: Date; end: Date }): Promise<SyncFreshness> {
  const pool = getCorePool();
  if (!pool) return { mirrorOrders: 0, unresolvedOrders: 0 };

  // Reaproveita o pool compartilhado (getCorePool) e o retry de conexao
  // (withConnectionRetry) ja usados por listMirrorTransactions: a mesma
  // classe de erro transitorio (57014/conexao derrubada em conexao recem
  // aberta contra o CORE_DB_URL) ja foi diagnosticada e resolvida la — sem
  // isso, esta rota rodando sozinha a cada hora reabriria conexao do zero
  // toda vez e ficaria exposta ao mesmo problema sem nenhum retry.
  const mirrorResult = await withConnectionRetry(() =>
    pool.query<{ mirror_orders: string }>(
      `
      SELECT count(DISTINCT rp.external_order_id) AS mirror_orders
      FROM mirror.raw_payloads rp
      WHERE rp.source = 'shopify'
        AND rp.payload_json IS NOT NULL
        AND (rp.payload_json->>'created_at')::timestamptz >= $1
        AND (rp.payload_json->>'created_at')::timestamptz < $2
      `,
      [window.start, window.end]
    )
  );
  const mirrorOrders = Number(mirrorResult.rows[0]?.mirror_orders ?? 0);

  try {
    const unresolvedResult = await withConnectionRetry(() =>
      pool.query<{ unresolved_orders: string }>(
        `
        SELECT count(DISTINCT rp.external_order_id) AS unresolved_orders
        FROM mirror.raw_payloads rp
        LEFT JOIN integration.shopify_order_payment_resolution spr
          ON spr.external_order_id = rp.external_order_id
        WHERE rp.source = 'shopify'
          AND rp.payload_json IS NOT NULL
          AND (rp.payload_json->>'created_at')::timestamptz >= $1
          AND (rp.payload_json->>'created_at')::timestamptz < $2
          AND spr.external_order_id IS NULL
        `,
        [window.start, window.end]
      )
    );
    return { mirrorOrders, unresolvedOrders: Number(unresolvedResult.rows[0]?.unresolved_orders ?? 0) };
  } catch (err) {
    // Tabela do job de resolução pode não existir ainda neste ambiente
    // (criada sob demanda por ensureShopifyPaymentResolutionTable). Não é
    // erro fatal para a verificação de faturamento/contagem.
    if (err instanceof Error && /does not exist/i.test(err.message)) {
      return { mirrorOrders, unresolvedOrders: mirrorOrders };
    }
    throw err;
  }
}

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  retries = 2
): Promise<TenderTransactionsResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        // Timeout generoso (rede local as vezes lenta ate a Shopify, ja
        // observado) — mas sempre limitado, nunca em aberto (uma execucao
        // anterior deste script travou ~3h com fetch sem timeout nenhum).
        signal: AbortSignal.timeout(30_000),
      });
      const json = await response.json();
      if (!response.ok || json.errors) {
        throw new Error(`Shopify GraphQL falhou: ${response.status} ${JSON.stringify(json.errors ?? json)}`);
      }
      return json.data;
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function dayWindowUtc(date: string, timezone: string): { start: Date; end: Date } {
  return {
    start: zonedDateToUtc(date, "00:00:00", timezone),
    end: zonedDateToUtc(nextDate(date), "00:00:00", timezone),
  };
}

function zonedDateToUtc(date: string, time: string, timezone: string): Date {
  const guess = new Date(`${date}T${time}.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asIfUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second)
  );
  const offset = asIfUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function yesterdayInTimeZone(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}
