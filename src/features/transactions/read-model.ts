import { Pool } from "pg";

import { getPrismaClient } from "@/core/db/prisma-client";
import { resolveShopifyPaymentMethod as resolveShopifyPaymentMethodFull } from "@/features/integration/payment-method";
import {
  resolveShopifyDiscountCents,
  resolveShopifyShippingCents,
} from "@/features/integration/shopify-order-mapper";
import type { DominantPaymentMethodResult } from "@/features/integration/shopify-order-transactions";
import type { ShopifyOrderPayload } from "@/features/integration/types";
import {
  classifyPaymentMethod,
  transactionMatchesPaymentMethod,
} from "@/features/transactions/payment-method-filter";
import { getCoreConnectionString } from "@/shared/read-model-config";
import type {
  FinancialTransaction,
  ListTransactionsFilters,
  PaymentMethod,
  PaginatedTransactions,
  TransactionSource,
} from "@/features/transactions/types";

type MirrorRow = {
  id: string;
  source: string | null;
  event_type: string | null;
  external_order_id: string | null;
  payload_json: unknown;
  received_at: Date | null;
  mirror_updated_at: Date | null;
  processing_status: string | null;
  resolved_gateway_raw: string | null;
  resolved_transaction_processed_at: Date | null;
};

const MIRROR_ROW_COLUMNS = `
  rp.id, rp.source, rp.event_type, rp.external_order_id, rp.payload_json,
  rp.received_at, rp.mirror_updated_at, rp.processing_status,
  spr.dominant_gateway_raw AS resolved_gateway_raw,
  spr.transaction_processed_at AS resolved_transaction_processed_at
`;

const MIRROR_ROW_JOIN = `
  FROM mirror.raw_payloads rp
  LEFT JOIN integration.shopify_order_payment_resolution spr
    ON spr.external_order_id = rp.external_order_id AND rp.source = 'shopify'
`;

// Fallback usado quando integration.shopify_order_payment_resolution ainda
// nao existe no banco (job de resolucao nunca rodou nesse ambiente/ainda nao
// processou nenhum pedido) — evita que a pagina de transacoes/fluxo de caixa
// quebre por completo por causa de uma tabela auxiliar ausente; cai na
// heuristica de payment_gateway_names ate a tabela existir.
const MIRROR_ROW_COLUMNS_FALLBACK = `
  rp.id, rp.source, rp.event_type, rp.external_order_id, rp.payload_json,
  rp.received_at, rp.mirror_updated_at, rp.processing_status,
  NULL::text AS resolved_gateway_raw,
  NULL::timestamptz AS resolved_transaction_processed_at
`;

const MIRROR_ROW_JOIN_FALLBACK = `FROM mirror.raw_payloads rp`;

// Folga tolerada entre a data do pedido (occurredAt) e o momento em que a
// linha chegou no mirror (received_at) — cobre backfill/reprocessamento
// atrasado sem obrigar a varrer a tabela inteira ate "agora" a cada consulta.
const RECEIVED_AT_GRACE_MS = 21 * 24 * 60 * 60 * 1000;

let resolutionTableKnownMissing = false;

function isMissingResolutionTableError(error: unknown): boolean {
  const pgError = error as { code?: string; message?: string };
  return (
    pgError?.code === "42P01" &&
    typeof pgError.message === "string" &&
    pgError.message.includes("shopify_order_payment_resolution")
  );
}

function buildMirrorQuery(columns: string, join: string, whereSql: string, tailSql: string): string {
  return `
    SELECT ${columns}
    ${join}
    WHERE ${whereSql}
    ${tailSql}
  `;
}

function isMirrorRowPaid(row: MirrorRow): boolean {
  const payload = asRecord(row.payload_json);
  if (!payload) return false;
  return isMirrorOrderPaid(row, payload);
}

// mirror.raw_payloads guarda 1 linha por evento recebido, nao 1 por pedido —
// reentregas de webhook/backfill duplicam o mesmo external_order_id. Dedup em
// JS (nao em SQL, ex.: DISTINCT ON numa CTE) de proposito: a versao em SQL
// tornava a query pesada o bastante para falhar de forma intermitente
// (Connection terminated unexpectedly / statement timeout) quando rodada
// dentro de computeCashFlow, que dispara periodo atual e anterior em paralelo
// no mesmo pool (max: 2).
//
// Prioriza "pago" sobre recencia pura: o worker de sync pode persistir o
// evento orders/create (financial_status=pending) alguns milissegundos DEPOIS
// de orders/paid, pela ordem de processamento da fila, nao pela ordem real
// dos eventos na Shopify — pegar so a linha mais recente por timestamp
// escondia pedidos genuinamente pagos atras do evento de criacao (bug real
// observado: derrubava a contagem de pedidos pagos do dia em ~60%). Uma vez
// pago, o pedido continua pago; entre linhas com o mesmo status de pagamento,
// desempate pela mais recente.
function dedupeMirrorRows(rows: MirrorRow[]): MirrorRow[] {
  const latestByKey = new Map<string, MirrorRow>();

  for (const row of rows) {
    const key = `${row.external_order_id ?? row.id}::${row.source ?? ""}`;
    const current = latestByKey.get(key);
    if (!current) {
      latestByKey.set(key, row);
      continue;
    }

    const currentPaid = isMirrorRowPaid(current);
    const rowPaid = isMirrorRowPaid(row);
    if (rowPaid !== currentPaid) {
      if (rowPaid) latestByKey.set(key, row);
      continue;
    }

    const currentTime = current.mirror_updated_at ?? current.received_at;
    const rowTime = row.mirror_updated_at ?? row.received_at;
    if (rowTime && (!currentTime || rowTime > currentTime)) {
      latestByKey.set(key, row);
    }
  }

  return [...latestByKey.values()];
}

// Quedas de conexao (nao erros de SQL) observadas de forma intermitente
// contra o CORE_DB_URL, mesmo com uma unica query sequencial — instabilidade
// de rede/pooler fora do nosso controle. Um retry curto absorve o blip sem
// propagar erro pro usuario final; se persistir apos as tentativas, o erro
// original sobe normalmente.
function isTransientConnectionError(error: unknown): boolean {
  const err = error as { message?: string; code?: string } | null;
  if (!err) return false;
  if (typeof err.message === "string" && err.message.includes("Connection terminated unexpectedly")) {
    return true;
  }
  // 57014 (statement timeout) tambem entra aqui: numa conexao recem-aberta
  // (ex.: primeira consulta apos o processo subir), a mesma query que roda
  // em ~300ms isolada as vezes estoura o statement_timeout so por causa da
  // lentidao de handshake da rede local ate o Supabase — nao pelo custo real
  // da query (confirmado via EXPLAIN ANALYZE). Retry curto tende a pegar uma
  // conexao ja estabelecida e resolver.
  return ["ECONNRESET", "ETIMEDOUT", "08006", "08003", "08001", "57014"].includes(err.code ?? "");
}

async function withConnectionRetry<T>(run: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientConnectionError(error) || attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function queryMirrorRows(
  pool: Pool,
  values: unknown[],
  whereSql: string,
  tailSql = ""
): Promise<{ rows: MirrorRow[] }> {
  if (!resolutionTableKnownMissing) {
    try {
      const result = await withConnectionRetry(() =>
        pool.query<MirrorRow>(buildMirrorQuery(MIRROR_ROW_COLUMNS, MIRROR_ROW_JOIN, whereSql, tailSql), values)
      );
      return { rows: dedupeMirrorRows(result.rows) };
    } catch (error) {
      if (!isMissingResolutionTableError(error)) {
        throw error;
      }
      resolutionTableKnownMissing = true;
    }
  }

  const result = await withConnectionRetry(() =>
    pool.query<MirrorRow>(buildMirrorQuery(MIRROR_ROW_COLUMNS_FALLBACK, MIRROR_ROW_JOIN_FALLBACK, whereSql, tailSql), values)
  );
  return { rows: dedupeMirrorRows(result.rows) };
}

type MirrorPayload = Record<string, unknown>;

type ReadModelFilters = Omit<ListTransactionsFilters, "page" | "limit" | "source" | "sources"> & {
  source?: string;
  sources?: string[];
};

let corePool: Pool | null = null;

function getCorePool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) {
    return null;
  }

  if (!corePool) {
    corePool = new Pool({
      connectionString,
      application_name: "sistema-financeiro-read-model",
      max: 2,
      // Falhar rapido em vez de ficar pendurado indefinidamente quando a
      // rede/banco fica instavel (ja observado nesta investigacao).
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      // Defesa contra pooler (Supavisor) derrubando conexoes ociosas do lado
      // do servidor sem avisar o cliente — sem TCP keepalive, o driver so
      // percebe na proxima tentativa de uso, e fica pendurado esperando
      // resposta de um socket morto. idleTimeoutMillis reduz a chance de a
      // conexao ficar ociosa tempo suficiente pro pooler mata-la primeiro.
      // NOTA: a lentidao de minutos observada em teste local (26/07) teve
      // causa DIFERENTE — confirmada via pg_stat_activity como wait_event
      // ClientWrite, ou seja, o Postgres ja tinha o resultado pronto e
      // estava so tentando transmitir o payload_json inteiro (JSON bruto do
      // pedido, ~10-30KB por linha) pela rede local ate o Supabase (us-east-1).
      // Nao e' bug de conexao/query; e' volume de dados x banda da rede local
      // de dev. Reduzir os bytes trafegados (projetar so os campos usados do
      // JSON via SQL em vez de "payload_json" inteiro) resolveria de raiz, mas
      // e' uma reescrita maior, nao feita nesta rodada.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      idleTimeoutMillis: 15_000,
    });
  }

  return corePool;
}

function asRecord(value: unknown): MirrorPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as MirrorPayload;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.replace(/\./g, value.includes(",") ? "" : ".").replace(",", ".").trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function moneyToCents(value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === null) return 0;
  return Math.round(parsed * 100);
}

function resolveShopMoneyAmount(payload: MirrorPayload, key: string): number {
  const nested = asRecord(payload[key]);
  const shopMoney = nested ? asRecord(nested.shop_money) : null;
  return moneyToCents(shopMoney?.amount);
}

function resolveStringDate(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = asString(value);
    if (!candidate) continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return null;
}

function normalizeMarketplace(value: string | null, source: string | null): string | null {
  if (source === "shopify") return "Shopify";
  if (!value) return null;

  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function resolveMirrorSource(source: string | null): TransactionSource {
  if (source === "shopify") return "webhook";
  return "integration";
}

function normalizeStatusToken(value: string | null): string | null {
  if (!value) return null;
  return value.trim().toUpperCase().replace(/\s+/g, "_");
}

function isPaidStatusToken(value: string | null): boolean {
  const normalized = normalizeStatusToken(value);
  if (!normalized) return false;

  if (normalized === "PAID" || normalized === "PAGO" || normalized === "PAGA") {
    return true;
  }

  return normalized.startsWith("PAID_");
}

function isMirrorOrderPaid(row: MirrorRow, payload: MirrorPayload): boolean {
  if (row.source === "shopify") {
    return (
      isPaidStatusToken(asString(payload.financial_status)) ||
      isPaidStatusToken(asString(payload.display_financial_status)) ||
      isPaidStatusToken(row.event_type)
    );
  }

  if (row.source === "anymarket") {
    if (isPaidStatusToken(asString(payload.paymentStatus))) {
      return true;
    }

    if (isPaidStatusToken(asString(payload.status))) {
      return true;
    }

    const payments = payload.payments;
    if (Array.isArray(payments)) {
      for (const paymentEntry of payments) {
        const payment = asRecord(paymentEntry);
        if (isPaidStatusToken(asString(payment?.status))) {
          return true;
        }
      }
    }

    return false;
  }

  return false;
}

function resolveAnymarketPaymentMethod(payload: MirrorPayload): string | null {
  const payments = payload.payments;
  if (!Array.isArray(payments) || payments.length === 0) return null;
  const first = asRecord(payments[0]);
  return (
    asString(first?.paymentMethodNormalized) ??
    asString(first?.paymentDetailNormalized) ??
    asString(first?.method)
  );
}

function resolveAnymarketFeeCents(payload: MirrorPayload): number {
  const payments = payload.payments;
  if (!Array.isArray(payments)) return 0;

  return payments.reduce((sum, entry) => {
    const payment = asRecord(entry);
    return sum + moneyToCents(payment?.marketplaceFee) + moneyToCents(payment?.gatewayFee);
  }, 0);
}

function mapMirrorRow(row: MirrorRow): FinancialTransaction | null {
  const payload = asRecord(row.payload_json);
  if (!payload || !row.source) return null;

  // Regra de negocio: apenas pedidos efetivamente pagos entram no financeiro.
  if (!isMirrorOrderPaid(row, payload)) {
    return null;
  }

  const occurredAt =
    row.source === "anymarket"
      ? resolveStringDate(payload.paymentDate, payload.createdAt, payload.lastUpdate, row.received_at?.toISOString())
      : resolveStringDate(
          row.resolved_transaction_processed_at?.toISOString(),
          payload.processed_at,
          payload.created_at,
          payload.updated_at,
          row.received_at?.toISOString()
        );

  if (!occurredAt) return null;

  const marketplace = normalizeMarketplace(asString(payload.marketPlace), row.source);
  const orderNumber =
    row.source === "anymarket"
      ? asString(payload.marketPlaceNumber)
      : asString(payload.name) ?? asString(payload.order_number) ?? asString(payload.number);

  // Gateway titular resolvido por valor (maior R$ pago no pedido, via
  // integration.shopify_order_payment_resolution) tem prioridade sobre a
  // heuristica de texto (payment_gateway_names/note/tags/transactions) — so
  // cai no heuristico para pedidos que o job de resolucao ainda nao
  // processou. resolveShopifyPaymentMethodFull e' a mesma logica usada pelo
  // mapeador de sync (shopify-order-mapper.ts) — unificado aqui para nao
  // manter uma versao reduzida em paralelo (so olhava payment_gateway_names/
  // note_attributes, perdendo os fallbacks por nota/tag/transacao).
  const shopifyDominant: DominantPaymentMethodResult | null = row.resolved_gateway_raw
    ? {
        gatewayRaw: row.resolved_gateway_raw,
        dominantAmountCents: 0,
        totalAmountCents: 0,
        processedAt: row.resolved_transaction_processed_at?.toISOString() ?? null,
      }
    : null;

  const paymentMethodRaw =
    row.source === "anymarket"
      ? resolveAnymarketPaymentMethod(payload)
      : resolveShopifyPaymentMethodFull(payload as unknown as ShopifyOrderPayload, shopifyDominant).raw;

  // Fallbacks de shipping_lines / calculo derivado por balanco (ver
  // resolveShopifyShippingCents/resolveShopifyDiscountCents em
  // shopify-order-mapper.ts) unificados aqui — o caminho antigo so olhava
  // total_shipping_price_set/current_shipping_price_set (este ultimo nome de
  // campo nem existe no payload real da Shopify, sempre retornava 0).
  const shippingCents =
    row.source === "anymarket"
      ? moneyToCents(payload.freight)
      : resolveShopifyShippingCents(payload as unknown as ShopifyOrderPayload);

  const discountCents =
    row.source === "anymarket"
      ? moneyToCents(payload.discount)
      : resolveShopifyDiscountCents(payload as unknown as ShopifyOrderPayload);

  const feeCents =
    row.source === "anymarket"
      ? resolveAnymarketFeeCents(payload)
      : resolveShopMoneyAmount(payload, "current_total_additional_fees_set");

  const taxCents = row.source === "shopify" ? resolveShopMoneyAmount(payload, "current_total_tax_set") : 0;

  const amountCents =
    row.source === "anymarket"
      ? moneyToCents(payload.total)
      : moneyToCents(payload.total_price) || moneyToCents(payload.current_total_price);

  const liquidCents = Math.max(
    0,
    amountCents - shippingCents - discountCents - taxCents - feeCents
  );

  if (amountCents <= 0) return null;

  const createdAt = row.received_at?.toISOString() ?? occurredAt;
  const updatedAt = row.mirror_updated_at?.toISOString() ?? createdAt;

  return {
    id: row.id,
    externalSource: row.source,
    externalId: row.external_order_id,
    marketplace,
    orderNumber,
    paymentMethodRaw,
    paymentMethodNormalized: classifyPaymentMethod(paymentMethodRaw),
    shippingCents,
    discountCents,
    taxCents,
    feeCents,
    liquidCents,
    type: "income",
    categoryId: null,
    amountCents,
    currency: asString(payload.currency) ?? "BRL",
    occurredAt,
    description: orderNumber ? `Pedido ${orderNumber}` : `Pedido ${row.external_order_id ?? row.id}`,
    source: resolveMirrorSource(row.source),
    status: row.processing_status === "failed" ? "rejected" : "approved",
    createdBy: null,
    updatedBy: null,
    changeReason: null,
    createdAt,
    updatedAt,
    deletedAt: null,
  };
}

function normalizeMarketplaceToken(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");

  if (!normalized) return null;
  if (normalized === "mercadolivre") return "mercado_livre";
  if (normalized === "todos" || normalized === "all") return null;

  return normalized;
}

function transactionMatchesMarketplaceFilter(
  item: FinancialTransaction,
  marketplace: string
): boolean {
  const target = normalizeMarketplaceToken(marketplace);
  if (!target) return true;

  const candidates = [
    normalizeMarketplaceToken(item.marketplace),
    normalizeMarketplaceToken(item.externalSource),
  ].filter((value): value is string => Boolean(value));

  return candidates.includes(target);
}

function filterTransactions(items: FinancialTransaction[], filters: ReadModelFilters): FinancialTransaction[] {
  return items.filter((item) => {
    if (filters.type && item.type !== filters.type) return false;
    if (filters.source && item.source !== filters.source) return false;
    if (filters.sources && filters.sources.length > 0 && !filters.sources.includes(item.source)) return false;
    if (filters.status && item.status !== filters.status) return false;
    if (filters.marketplace && !transactionMatchesMarketplaceFilter(item, filters.marketplace)) {
      return false;
    }
    if (filters.categoryId && item.categoryId !== filters.categoryId) return false;
    if (filters.paymentMethod && !transactionMatchesPaymentMethod(item, filters.paymentMethod)) return false;
    if (filters.startDate && new Date(item.occurredAt) < new Date(filters.startDate)) return false;
    if (filters.endDate && new Date(item.occurredAt) > new Date(filters.endDate)) return false;
    if (filters.search) {
      const term = filters.search.toLowerCase();
      const haystack = [item.description, item.externalId, item.orderNumber, item.marketplace]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

async function listMirrorTransactions(filters: ReadModelFilters): Promise<FinancialTransaction[]> {
  const pool = getCorePool();
  if (!pool) return [];

  if (filters.type && filters.type !== "income") {
    return [];
  }

  // Pre-filtro de performance por received_at, mesmo raciocinio aplicado em
  // listMarketplaceReadModelPaginated: so o limite inferior e seguro (uma linha
  // nunca chega no mirror antes do pedido existir), o corte fino por periodo
  // continua sendo feito por occurredAt em filterTransactions(). Sem isso, esta
  // query varre 100% de mirror.raw_payloads a cada chamada (medido: 25-70s numa
  // tabela com ~1.4M linhas), o que e um risco real de timeout em produção.
  const conditions: string[] = ["rp.payload_json IS NOT NULL", "rp.source IN ('shopify', 'anymarket')"];
  const values: unknown[] = [];
  const dateStart = parseFilterDate(filters.startDate);
  if (dateStart) {
    values.push(dateStart);
    conditions.push(`rp.received_at >= $${values.length}`);
  }

  // Limite superior com folga (nao o fim exato do periodo, que continua sendo
  // decidido por occurredAt em filterTransactions) — sem isso, consultar um
  // periodo antigo varre tudo ate o presente numa tabela de ~1.4M linhas em
  // crescimento continuo, o que ja causou timeout/instabilidade de conexao
  // rodando em paralelo com o periodo anterior via Promise.all.
  const dateEnd = parseFilterDate(filters.endDate);
  if (dateEnd) {
    const boundedEnd = new Date(Math.min(dateEnd.getTime() + RECEIVED_AT_GRACE_MS, Date.now()));
    values.push(boundedEnd);
    conditions.push(`rp.received_at <= $${values.length}`);
  }

  const rows = await queryMirrorRows(pool, values, conditions.join(" AND "));

  return filterTransactions(
    rows.rows
      .map(mapMirrorRow)
      .filter((item): item is FinancialTransaction => Boolean(item)),
    filters
  );
}

async function listPrismaTransactions(filters: ReadModelFilters): Promise<FinancialTransaction[]> {
  const prisma = getPrismaClient();
  const where: Record<string, unknown> = {
    deletedAt: null,
    source: { in: ["manual", "import"] },
  };

  if (filters.type) where.type = filters.type;
  if (filters.source) where.source = filters.source;
  if (filters.sources && filters.sources.length > 0) where.source = { in: filters.sources.filter((source) => source === "manual" || source === "import") };
  if (filters.status) where.status = filters.status;
  if (filters.categoryId) where.categoryId = filters.categoryId;

  if (filters.startDate || filters.endDate) {
    where.occurredAt = {};
    if (filters.startDate) (where.occurredAt as Record<string, unknown>).gte = new Date(filters.startDate);
    if (filters.endDate) (where.occurredAt as Record<string, unknown>).lte = new Date(filters.endDate);
  }

  let rows: Array<{
    id: string;
    externalSource: string | null;
    externalId: string | null;
    marketplace: string | null;
    orderNumber: string | null;
    paymentMethodRaw: string | null;
    paymentMethodNormalized: string | null;
    shippingCents: number | null;
    discountCents: number | null;
    taxCents: number | null;
    feeCents: number | null;
    type: string;
    categoryId: string | null;
    amountCents: number;
    currency: string;
    occurredAt: Date;
    description: string | null;
    source: string;
    status: string;
    createdBy: string | null;
    updatedBy: string | null;
    changeReason: string | null;
    deletedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> = [];

  try {
    rows = await prisma.financialTransaction.findMany({
      where,
      orderBy: { occurredAt: "desc" },
    });
  } catch {
    // Em ambiente de transicao pode nao existir FinancialTransaction no banco corrente.
    return [];
  }

  const mapped = rows.map((item) => ({
    id: item.id,
    externalSource: item.externalSource,
    externalId: item.externalId,
    marketplace: item.marketplace,
    orderNumber: item.orderNumber,
    paymentMethodRaw: item.paymentMethodRaw,
    paymentMethodNormalized: item.paymentMethodNormalized as FinancialTransaction["paymentMethodNormalized"],
    shippingCents: item.shippingCents ?? 0,
    discountCents: item.discountCents ?? 0,
    taxCents: item.taxCents ?? 0,
    feeCents: item.feeCents ?? 0,
    liquidCents: Math.max(
      0,
      item.amountCents -
        (item.shippingCents ?? 0) -
        (item.discountCents ?? 0) -
        (item.taxCents ?? 0) -
        (item.feeCents ?? 0)
    ),
    type: item.type as FinancialTransaction["type"],
    categoryId: item.categoryId,
    amountCents: item.amountCents,
    currency: item.currency,
    occurredAt: item.occurredAt.toISOString(),
    description: item.description,
    source: item.source as FinancialTransaction["source"],
    status: item.status as FinancialTransaction["status"],
    createdBy: item.createdBy,
    updatedBy: item.updatedBy,
    changeReason: item.changeReason,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
  }));

  return filterTransactions(mapped, filters);
}

export async function listFinancialReadModelTransactions(
  filters: ReadModelFilters
): Promise<FinancialTransaction[]> {
  const [mirrorItems, prismaItems] = await Promise.all([
    listMirrorTransactions(filters),
    listPrismaTransactions(filters),
  ]);

  return [...mirrorItems, ...prismaItems].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt)
  );
}

export async function listFinancialReadModelPaginated(
  filters: ListTransactionsFilters
): Promise<PaginatedTransactions> {
  const items = await listFinancialReadModelTransactions(filters);
  const offset = (filters.page - 1) * filters.limit;
  const pageItems = items.slice(offset, offset + filters.limit);

  return {
    items: pageItems,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: items.length,
      hasNext: offset + filters.limit < items.length,
    },
  };
}

type MarketplaceReadModelFilters = {
  page: number;
  limit: number;
  marketplace?: string;
  paymentMethod?: PaymentMethod;
  startDate?: string;
  endDate?: string;
};

function parseFilterDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listMarketplaceReadModelPaginated(
  filters: MarketplaceReadModelFilters
): Promise<PaginatedTransactions> {
  const readModelFilters: ReadModelFilters = {
    type: "income",
    sources: ["integration", "webhook"],
    marketplace: filters.marketplace,
    paymentMethod: filters.paymentMethod,
    startDate: filters.startDate,
    endDate: filters.endDate,
  };

  // Mesma fonte usada por "POR ORIGEM" (via listFinancialReadModelTransactions),
  // ja validada: busca completa do periodo (pre-filtrada por received_at) +
  // dedup global. listMirrorTransactions nao define ORDER BY (usada hoje so
  // para agregacao, onde ordem nao importa), entao a ordenacao pro cursor de
  // pagina precisa ser aplicada aqui.
  const items = (await listMirrorTransactions(readModelFilters)).sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt)
  );

  const offset = (filters.page - 1) * filters.limit;
  const pageItems = items.slice(offset, offset + filters.limit);

  return {
    items: pageItems,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: items.length,
      hasNext: offset + filters.limit < items.length,
    },
  };
}