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
 * funcao que alimenta a tela /fluxo-de-caixa.
 *
 * Lado Shopify: reusa a metodologia validada em
 * docs/shopify/shopify-payments-by-gateway.md (tenderTransactions + REST
 * orders/{id}/transactions.json, filtrado por transaction.processed_at, kind
 * sale/capture/change, status success).
 *
 * "Transacoes" aqui = pedidos pagos (nao eventos de pagamento da Shopify).
 */

import { computeCashFlow } from "@/features/cash-flow/service";
import { classifyPaymentMethod } from "@/features/transactions/payment-method-filter";
import { getCorePool, withConnectionRetry } from "@/features/transactions/mirror-events-repository";
// dayWindowUtc/zonedDateToUtc nasceram aqui e eram a unica conversao de fuso
// correta do repo. Foram para @/lib/date-utils para virar a convencao unica do
// sistema, em vez de conviverem com as fronteiras por fuso de processo.
import { addDaysToDayKey, dayWindowUtc } from "@/lib/date-utils";

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
  // Na base de pagamentos a contagem do sistema ja e de transacoes, e o
  // comparavel do lado da Shopify passa a ser o numero de transacoes tambem.
  const contagemShopify =
    financeiroSource?.basis === "payments" ? shopify.transactionCount : shopify.orderCount;
  const rotuloContagem =
    financeiroSource?.basis === "payments"
      ? "Nº de transações (pagamentos processados)"
      : "Nº de transações (pedidos pagos)";

  return {
    date,
    timezone: VERIFICATION_TIMEZONE,
    windowUtc: { start: window.start.toISOString(), endExclusive: window.end.toISOString() },
    metrics: [
      buildMetric("Faturamento bruto", financeiroGrossCents, shopify.grossCents, toleranceCents, formatMoney),
      buildMetric(rotuloContagem, financeiroOrderCount, contagemShopify, 0, (value) => String(value)),
      // Por gateway, e nao so o total: em 30/08/2026 o credito na loja estava
      // R$ 190,70 ACIMA e o cartao R$ 2.563,79 abaixo. No total as duas se
      // cancelam parcialmente e o alarme subestima o tamanho do problema.
      ...buildGatewayMetrics(financeiro.byPaymentMethod, shopify.byGateway, toleranceCents),
    ],
    syncFreshness: freshness,
    maturity: computeMaturity(window, freshness),
    shopifyCandidateOrders: shopify.candidateOrders,
  };
}

/**
 * Uma metrica por forma de pagamento, comparando o que o Fluxo de Caixa mostra
 * com o que a Shopify processou.
 *
 * Agrupa os gateways crus da Shopify pela MESMA classificacao que o sistema usa
 * (classifyPaymentMethod), senao "Pix (3% de desconto)" nunca casaria com "pix".
 */
function buildGatewayMetrics(
  financeiroByMethod: Array<{ paymentMethod: string; grossCents: number }>,
  shopifyByGateway: Map<string, { grossCents: number; transactionCount: number }>,
  toleranceCents: number
): VerificationMetric[] {
  const shopifyByMethod = new Map<string, number>();
  for (const [gateway, bucket] of shopifyByGateway) {
    const method = classifyPaymentMethod(gateway);
    shopifyByMethod.set(method, (shopifyByMethod.get(method) ?? 0) + bucket.grossCents);
  }

  const financeiroByMethodMap = new Map(financeiroByMethod.map((row) => [row.paymentMethod, row.grossCents]));
  const metodos = [...new Set([...financeiroByMethodMap.keys(), ...shopifyByMethod.keys()])].sort();

  return metodos.map((metodo) =>
    buildMetric(
      `Faturamento — ${metodo}`,
      financeiroByMethodMap.get(metodo) ?? 0,
      shopifyByMethod.get(metodo) ?? 0,
      toleranceCents,
      formatMoney
    )
  );
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
  transactionCount: number;
  candidateOrders: number;
  byGateway: Map<string, { grossCents: number; transactionCount: number }>;
};

async function loadShopifySide(
  storeDomain: string,
  accessToken: string,
  date: string,
  window: { start: Date; end: Date },
  concurrency: number
): Promise<ShopifySide> {
  // tenderTransactions SOZINHO nao serve como conjunto candidato: ele nao emite
  // entrada para pedido pago inteiramente com credito na loja. Medido em
  // 30/08/2026 — por esta via so aparecem 13 pagamentos de credito na loja
  // (R$ 1.534,16) contra os 22 (R$ 3.050,96) do relatorio da Shopify, e o total
  // do dia sai R$ 3.820,23 abaixo. Era esse o motivo de esta verificacao ler
  // baixo todo dia, e nao o fuso da janela.
  //
  // A uniao com os pedidos do mirror cobre o buraco: quem paga so com credito
  // na loja continua sendo um pedido normal no mirror. Um pedido que nao esteja
  // em nenhuma das duas pontas segue invisivel — limitacao conhecida, e bem
  // menor que a anterior.
  const [tenderIds, mirrorIds] = await Promise.all([
    loadTenderTransactionOrderIds(storeDomain, accessToken, date, window),
    loadMirrorOrderIds(window),
  ]);
  const orderIds = new Set([...tenderIds, ...mirrorIds]);

  const transactions = await loadOrderTransactions(storeDomain, accessToken, [...orderIds], window, concurrency);

  const grossByOrder = new Map<string, number>();
  const byGateway = new Map<string, { grossCents: number; transactionCount: number }>();
  let transactionCount = 0;

  for (const { orderId, transaction } of transactions) {
    if (transaction.status !== SUCCESS_STATUS) continue;
    if (!GROSS_KINDS.has(transaction.kind)) continue;

    grossByOrder.set(orderId, (grossByOrder.get(orderId) ?? 0) + transaction.amountCents);
    transactionCount += 1;

    const bucket = byGateway.get(transaction.gateway) ?? { grossCents: 0, transactionCount: 0 };
    bucket.grossCents += transaction.amountCents;
    bucket.transactionCount += 1;
    byGateway.set(transaction.gateway, bucket);
  }

  const grossCents = [...grossByOrder.values()].reduce((sum, value) => sum + value, 0);

  return {
    grossCents,
    orderCount: grossByOrder.size,
    transactionCount,
    candidateOrders: orderIds.size,
    byGateway,
  };
}

/**
 * Pedidos Shopify que o mirror conhece na janela, para completar o conjunto
 * candidato. Recorta pela data do pagamento quando ela existe (resolucao de
 * gateway ja rodou) e cai no created_at do payload quando nao existe.
 */
async function loadMirrorOrderIds(window: { start: Date; end: Date }): Promise<Set<string>> {
  const pool = getCorePool();
  if (!pool) return new Set();

  const result = await withConnectionRetry(() =>
    pool.query<{ external_order_id: string }>(
      `
      SELECT DISTINCT rp.external_order_id
      FROM mirror.raw_payloads rp
      LEFT JOIN integration.shopify_order_payment_resolution spr
        ON spr.external_order_id = rp.external_order_id
      WHERE rp.source = 'shopify'
        AND rp.external_order_id IS NOT NULL
        AND rp.payload_json IS NOT NULL
        AND COALESCE(spr.transaction_processed_at, (rp.payload_json->>'created_at')::timestamptz) >= $1
        AND COALESCE(spr.transaction_processed_at, (rp.payload_json->>'created_at')::timestamptz) < $2
      `,
      [window.start, window.end]
    )
  );

  return new Set(result.rows.map((row) => row.external_order_id));
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

function nextDate(date: string): string {
  return addDaysToDayKey(date, 1);
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
