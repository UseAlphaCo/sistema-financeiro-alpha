import {
  transactionMatchesPaymentMethod,
} from "@/features/transactions/payment-method-filter";
import type {
  FinancialTransaction,
  ListTransactionsFilters,
  PaymentMethod,
} from "@/features/transactions/types";

/**
 * Tipos e filtros do read model financeiro.
 *
 * Existe como modulo proprio para quebrar o ciclo que apareceria se ficasse
 * junto do mapeador ou do repositorio: os tres precisam de `MirrorRow`, o
 * repositorio precisa do mapeador (dedup) e o read model precisa dos dois.
 * Tipo compartilhado em modulo folha e a forma barata de resolver isso.
 */

/** Linha crua do mirror, ja com a resolucao de gateway anexada pelo LEFT JOIN. */
export type MirrorRow = {
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

export type MirrorPayload = Record<string, unknown>;

/**
 * Pedido materializado, na forma em que e gravado em
 * integration.financial_orders.
 *
 * Mora aqui, no modulo folha, e nao no repositorio: quem PRODUZ este objeto e o
 * mapeador puro, que nao pode depender de um modulo que importa `pg` nem que
 * seja so para o tipo.
 */
export type MaterializedOrder = {
  source: string;
  /** COALESCE(external_order_id, id::text) -- a mesma chave do dedup. */
  orderKey: string;
  /** id do EVENTO vencedor do dedup; vira FinancialTransaction.id na UI. */
  mirrorRowId: string | null;
  externalId: string | null;
  occurredAt: string;
  marketplace: string | null;
  marketplaceKey: string | null;
  sourceKey: string | null;
  sourceBucket: string | null;
  orderNumber: string | null;
  description: string | null;
  paymentMethodRaw: string | null;
  paymentMethodNormalized: string | null;
  amountCents: number;
  shippingCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  liquidCents: number;
  currency: string;
  type: string;
  txSource: string;
  status: string;
  receivedAt: string | null;
  sourceUpdatedAt: string | null;
  searchText: string | null;
  contentHash: string;
};

export type MaterializedOrderKey = {
  source: string;
  orderKey: string;
};

export type ReadModelFilters = Omit<
  ListTransactionsFilters,
  "page" | "limit" | "source" | "sources"
> & {
  source?: string;
  sources?: string[];
};

export type MarketplaceReadModelFilters = {
  page: number;
  limit: number;
  marketplace?: string;
  paymentMethod?: PaymentMethod;
  startDate?: string;
  endDate?: string;
};

/**
 * Todo pedido vindo do mirror e mapeado com type "income", categoryId null e
 * source "webhook" (shopify) ou "integration" (demais) — ver mapMirrorRow e
 * resolveMirrorSource. Sao invariantes, nao valores derivados do payload.
 */
export const MIRROR_SOURCES: readonly string[] = ["integration", "webhook"];

export function normalizeMarketplaceToken(value: string | null | undefined): string | null {
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

export function filterTransactions(
  items: FinancialTransaction[],
  filters: ReadModelFilters
): FinancialTransaction[] {
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

/**
 * Decide, so pelos filtros, se o mirror nao tem como contribuir com nenhuma
 * linha — caso em que a query pode ser evitada por completo.
 *
 * Sem isso, uma chamada como a de /lancamentos (source "manual", sem datas)
 * varre 100% de mirror.raw_payloads (~1,4M linhas, payload de 10-30KB cada),
 * traz tudo para o Node e descarta o resultado inteiro em filterTransactions.
 *
 * Cada condicao aqui espelha um filtro de filterTransactions que reprovaria
 * *todas* as linhas do mirror por causa das invariantes acima. Ao mexer em
 * uma, mexer na outra.
 */
export function mirrorCannotContribute(filters: ReadModelFilters): boolean {
  // filterTransactions: item.type !== filters.type
  if (filters.type && filters.type !== "income") return true;

  // filterTransactions: item.categoryId !== filters.categoryId (sempre null)
  if (filters.categoryId) return true;

  // filterTransactions: item.source !== filters.source
  if (filters.source && !MIRROR_SOURCES.includes(filters.source)) return true;

  // filterTransactions: !filters.sources.includes(item.source)
  if (
    filters.sources &&
    filters.sources.length > 0 &&
    !filters.sources.some((source) => MIRROR_SOURCES.includes(source))
  ) {
    return true;
  }

  return false;
}

export function parseFilterDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
