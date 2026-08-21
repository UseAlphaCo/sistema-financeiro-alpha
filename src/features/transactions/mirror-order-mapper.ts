import { resolveShopifyPaymentMethod as resolveShopifyPaymentMethodFull } from "@/features/integration/payment-method";
import {
  resolveShopifyDiscountCents,
  resolveShopifyShippingCents,
} from "@/features/integration/shopify-order-mapper";
import type { DominantPaymentMethodResult } from "@/features/integration/shopify-order-transactions";
import type { ShopifyOrderPayload } from "@/features/integration/types";
import { classifyPaymentMethod } from "@/features/transactions/payment-method-filter";
import type { MirrorPayload, MirrorRow } from "@/features/transactions/read-model-filters";
import type { FinancialTransaction, TransactionSource } from "@/features/transactions/types";

/**
 * Transformacao evento-do-mirror -> pedido financeiro. Modulo PURO: nenhuma
 * dependencia de `pg`, de Prisma ou de configuracao.
 *
 * Extraido de read-model.ts sem mudanca de comportamento, para que a
 * materializacao (integration.financial_orders) e o caminho de request usem
 * exatamente a mesma regra. Duas copias desta logica divergiriam em semanas, e
 * a divergencia apareceria como numero errado na tela, nao como erro.
 */

export function asRecord(value: unknown): MirrorPayload | null {
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

export function isMirrorOrderPaid(row: MirrorRow, payload: MirrorPayload): boolean {
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

export function isMirrorRowPaid(row: MirrorRow): boolean {
  const payload = asRecord(row.payload_json);
  if (!payload) return false;
  return isMirrorOrderPaid(row, payload);
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
export function dedupeMirrorRows(rows: MirrorRow[]): MirrorRow[] {
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

export function mapMirrorRow(row: MirrorRow): FinancialTransaction | null {
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
