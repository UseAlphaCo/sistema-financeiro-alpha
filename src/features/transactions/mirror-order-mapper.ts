import { createHash } from "node:crypto";

import { resolveShopifyPaymentMethod as resolveShopifyPaymentMethodFull } from "@/features/integration/payment-method";
import {
  resolveShopifyDiscountCents,
  resolveShopifyShippingCents,
} from "@/features/integration/shopify-order-mapper";
import type { DominantPaymentMethodResult } from "@/features/integration/shopify-order-transactions";
import type { ShopifyOrderPayload } from "@/features/integration/types";
import { classifyPaymentMethod } from "@/features/transactions/payment-method-filter";
import {
  normalizeMarketplaceToken,
  type MaterializedOrder,
  type MirrorPayload,
  type MirrorRow,
} from "@/features/transactions/read-model-filters";
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

/**
 * Ordem total de recencia entre duas linhas do mesmo pedido. Positivo quando
 * `left` deve vencer.
 *
 * Existe porque o desempate anterior nao era uma ordem total: comparava
 * `mirror_updated_at ?? received_at` com `>` ESTRITO e, no empate, mantinha a
 * primeira linha que aparecesse. Como a consulta do mirror nao tem ORDER BY, a
 * "primeira" era a ordem fisica do heap -- ou seja, o vencedor de um empate
 * dependia de vacuum, de reescrita de pagina e da ordem em que o backfill
 * gravou. Duas execucoes da mesma consulta podiam devolver valores diferentes,
 * e o comentario de dedupeMirrorRows prometia o contrario.
 *
 * O empate nao e hipotetico: uma carga em bloco grava milhares de linhas com o
 * mesmo `mirror_updated_at`, e um reprocessamento de webhook grava o mesmo
 * evento com o mesmo `received_at`.
 *
 * `id` como ultimo critério e arbitrario de proposito -- o que importa e ser
 * ESTAVEL. Nao se resolve empate de conteudo por sorte de layout de disco.
 */
function compareMirrorRecency(left: MirrorRow, right: MirrorRow): number {
  const leftTime = (left.mirror_updated_at ?? left.received_at)?.getTime() ?? null;
  const rightTime = (right.mirror_updated_at ?? right.received_at)?.getTime() ?? null;

  if (leftTime !== rightTime) {
    // Linha sem data nenhuma perde de qualquer linha datada: e o mesmo
    // tratamento que o piso do sync e findRawPayloadsAfter dao a ela.
    if (leftTime === null) return -1;
    if (rightTime === null) return 1;
    return leftTime > rightTime ? 1 : -1;
  }

  if (left.id === right.id) return 0;
  return left.id > right.id ? 1 : -1;
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
// desempate pela mais recente, e por `id` quando a recencia tambem empata (ver
// compareMirrorRecency). O resultado nao depende da ordem de entrada -- e o que
// permite prometer o mesmo pedido vencedor no caminho de request e na
// materializacao, que leem as mesmas linhas em ordens diferentes.
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

    if (compareMirrorRecency(row, current) > 0) {
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

/**
 * Texto de busca pre-normalizado.
 *
 * Paridade byte a byte com o haystack de filterTransactions: os mesmos quatro
 * campos, na mesma ordem, `filter(Boolean)`, unidos por um espaco e em
 * minusculas. Se divergir, buscar pela tela e buscar pela tabela materializada
 * passam a devolver conjuntos diferentes -- e a diferenca so apareceria como
 * "nao acho esse pedido", nunca como erro.
 */
export function buildSearchText(order: {
  description: string | null;
  externalId: string | null;
  orderNumber: string | null;
  marketplace: string | null;
}): string | null {
  const haystack = [order.description, order.externalId, order.orderNumber, order.marketplace]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack ? haystack : null;
}

/**
 * Normaliza o termo digitado do mesmo jeito que buildSearchText normaliza o
 * texto indexado. Par obrigatorio: quem escreve em minusculas tem de procurar
 * em minusculas.
 */
export function normalizeSearchTerm(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Campos que entram no hash de conteudo, em ordem FIXA.
 *
 * received_at e source_updated_at ficam DE FORA de proposito: sao metadados de
 * quando a linha chegou, nao do que o pedido diz. Incluir faria toda recarga do
 * mirror (como a da Fase A) invalidar todas as linhas materializadas de uma vez
 * -- exatamente o oposto do que o guard de no-op existe para fazer.
 *
 * A ordem e fixa e o separador e 0x1f (unit separator), que nao ocorre nos
 * dados: com um separador comum, dois pedidos diferentes poderiam produzir a
 * mesma concatenacao e o guard veria como "sem mudanca".
 */
function contentHashParts(order: Omit<MaterializedOrder, "contentHash">): string[] {
  return [
    order.source,
    order.orderKey,
    order.mirrorRowId ?? "",
    order.externalId ?? "",
    order.occurredAt,
    order.marketplace ?? "",
    order.marketplaceKey ?? "",
    order.sourceKey ?? "",
    order.sourceBucket ?? "",
    order.orderNumber ?? "",
    order.description ?? "",
    order.paymentMethodRaw ?? "",
    order.paymentMethodNormalized ?? "",
    String(order.amountCents),
    String(order.shippingCents),
    String(order.discountCents),
    String(order.taxCents),
    String(order.feeCents),
    String(order.liquidCents),
    order.currency,
    order.type,
    order.txSource,
    order.status,
    order.searchText ?? "",
  ];
}

export function buildContentHash(order: Omit<MaterializedOrder, "contentHash">): string {
  return createHash("sha256").update(contentHashParts(order).join("\u001f")).digest("hex");
}

/**
 * Evento vencedor do dedup -> linha materializada.
 *
 * Delega a mapMirrorRow em vez de reimplementar: e o que garante que a
 * materializacao e o caminho de request concordem por construcao, e nao por
 * disciplina. Devolve null exatamente nos mesmos casos que mapMirrorRow (nao
 * pago, sem data, valor <= 0), e o chamador usa esse null para APAGAR a chave
 * -- senao pedido estornado soma para sempre.
 */
/** Motivo pelo qual um evento do mirror nao produz pedido financeiro. */
export type MaterializationRejection =
  | "sem_payload"
  | "sem_source"
  | "nao_pago"
  | "sem_data"
  | "valor_nao_positivo";

/**
 * Por que este evento nao produziu pedido -- ou null se produziu.
 *
 * Existe para a verificacao da materializacao ser DECOMPOSTA e nao um numero
 * agregado: "103.834 chaves geraram 91.640 pedidos" nao diz se os 12.194
 * restantes sao pedidos nao pagos (esperado) ou uma regressao no mapeamento
 * (grave). Sem a decomposicao, o comparador dos dois caminhos nao tem linha de
 * base.
 *
 * Reusa as MESMAS funcoes de mapMirrorRow, na mesma ordem. Reimplementar os
 * testes de rejeicao aqui criaria a divergencia que este modulo existe para
 * evitar.
 */
export function describeMaterializationRejection(row: MirrorRow): MaterializationRejection | null {
  const payload = asRecord(row.payload_json);
  if (!payload) return "sem_payload";
  if (!row.source) return "sem_source";
  if (!isMirrorOrderPaid(row, payload)) return "nao_pago";

  const order = toMaterializedOrder(row);
  if (order) return null;

  // Sobrou apenas o que mapMirrorRow rejeita depois do teste de pago: falta de
  // data utilizavel ou valor nao positivo. A ordem espelha a do mapeador.
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

  return occurredAt ? "valor_nao_positivo" : "sem_data";
}

export function toMaterializedOrder(row: MirrorRow): MaterializedOrder | null {
  const transaction = mapMirrorRow(row);
  if (!transaction || !row.source) return null;

  const payload = asRecord(row.payload_json);

  const base: Omit<MaterializedOrder, "contentHash"> = {
    source: row.source,
    orderKey: row.external_order_id ?? row.id,
    mirrorRowId: row.id,
    externalId: row.external_order_id,
    occurredAt: transaction.occurredAt,
    marketplace: transaction.marketplace,
    marketplaceKey: normalizeMarketplaceToken(transaction.marketplace),
    sourceKey: normalizeMarketplaceToken(transaction.externalSource),
    // marketplace ?? externalSource ?? source, e NAO o
    // COALESCE(NULLIF(marketplace,''), source) do SQL legado, que ignora
    // externalSource e por isso agrupa pedido de marketplace sob a origem
    // tecnica.
    sourceBucket: transaction.marketplace ?? transaction.externalSource ?? row.source,
    orderNumber: transaction.orderNumber,
    description: transaction.description,
    paymentMethodRaw: transaction.paymentMethodRaw,
    paymentMethodNormalized: transaction.paymentMethodNormalized,
    amountCents: transaction.amountCents,
    shippingCents: transaction.shippingCents,
    discountCents: transaction.discountCents,
    taxCents: transaction.taxCents,
    feeCents: transaction.feeCents,
    liquidCents: transaction.liquidCents,
    currency: transaction.currency,
    type: transaction.type,
    txSource: transaction.source,
    status: transaction.status,
    receivedAt: row.received_at?.toISOString() ?? null,
    // Data que a ORIGEM diz ter atualizado o pedido, nao a que o mirror gravou:
    // mirror_updated_at e metadado de infraestrutura e mudaria a cada recarga.
    sourceUpdatedAt: payload
      ? resolveStringDate(payload.updated_at, payload.lastUpdate, payload.updatedAt)
      : null,
    searchText: buildSearchText({
      description: transaction.description,
      externalId: transaction.externalId,
      orderNumber: transaction.orderNumber,
      marketplace: transaction.marketplace,
    }),
  };

  return { ...base, contentHash: buildContentHash(base) };
}
