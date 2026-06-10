import { Pool } from "pg";

import { getPrismaClient } from "@/core/db/prisma-client";
import {
  getPaymentMethodSearchTokens,
  transactionMatchesPaymentMethod,
} from "@/features/transactions/payment-method-filter";
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
};

type MirrorPayload = Record<string, unknown>;

type ReadModelFilters = Omit<ListTransactionsFilters, "page" | "limit" | "source" | "sources"> & {
  source?: string;
  sources?: string[];
};

let corePool: Pool | null = null;

function getCorePool(): Pool | null {
  const connectionString = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  if (!corePool) {
    corePool = new Pool({
      connectionString,
      application_name: "sistema-financeiro-read-model",
      max: 2,
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

function normalizePaymentMethod(raw: string | null): PaymentMethod | null {
  if (!raw) return null;

  const methods: PaymentMethod[] = [
    "credit_card",
    "pix",
    "store_credit",
    "boleto",
    "bank_transfer",
    "wallet",
    "cash",
    "other",
  ];

  for (const method of methods) {
    if (method === "other") continue;
    if (getPaymentMethodSearchTokens(method).some((token) => raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(token.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()))) {
      return method;
    }
  }

  return "other";
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

function resolveShopifyPaymentMethod(payload: MirrorPayload): string | null {
  const gateways = payload.payment_gateway_names;
  if (Array.isArray(gateways)) {
    const values = gateways.map(asString).filter((value): value is string => Boolean(value));
    if (values.length > 0) return values.join(" + ");
  }

  const noteAttributes = payload.note_attributes;
  if (!Array.isArray(noteAttributes)) return null;

  for (const attribute of noteAttributes) {
    const item = asRecord(attribute);
    if (asString(item?.name) === "_payment_method") {
      return asString(item?.value);
    }
  }

  return null;
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
      : resolveStringDate(payload.processed_at, payload.created_at, payload.updated_at, row.received_at?.toISOString());

  if (!occurredAt) return null;

  const marketplace = normalizeMarketplace(asString(payload.marketPlace), row.source);
  const orderNumber =
    row.source === "anymarket"
      ? asString(payload.marketPlaceNumber)
      : asString(payload.name) ?? asString(payload.order_number) ?? asString(payload.number);

  const paymentMethodRaw =
    row.source === "anymarket" ? resolveAnymarketPaymentMethod(payload) : resolveShopifyPaymentMethod(payload);

  const shippingCents =
    row.source === "anymarket"
      ? moneyToCents(payload.freight)
      : resolveShopMoneyAmount(payload, "total_shipping_price_set") || resolveShopMoneyAmount(payload, "current_shipping_price_set");

  const discountCents =
    row.source === "anymarket"
      ? moneyToCents(payload.discount)
      : resolveShopMoneyAmount(payload, "current_total_discounts_set") || moneyToCents(payload.total_discounts) || moneyToCents(payload.current_total_discounts);

  const feeCents =
    row.source === "anymarket"
      ? resolveAnymarketFeeCents(payload)
      : resolveShopMoneyAmount(payload, "current_total_additional_fees_set");

  const taxCents = row.source === "shopify" ? resolveShopMoneyAmount(payload, "current_total_tax_set") : 0;

  const amountCents =
    row.source === "anymarket"
      ? moneyToCents(payload.total)
      : moneyToCents(payload.total_price) || moneyToCents(payload.current_total_price);

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
    paymentMethodNormalized: normalizePaymentMethod(paymentMethodRaw),
    shippingCents,
    discountCents,
    taxCents,
    feeCents,
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

  const rows = await pool.query<MirrorRow>(`
    SELECT id, source, event_type, external_order_id, payload_json, received_at, mirror_updated_at, processing_status
    FROM mirror.raw_payloads
    WHERE payload_json IS NOT NULL
      AND source IN ('shopify', 'anymarket')
  `);

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
  const pool = getCorePool();
  if (!pool) {
    return {
      items: [],
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total: 0,
        hasNext: false,
      },
    };
  }

  const targetSkip = (filters.page - 1) * filters.limit;
  const chunkSize = Math.max(filters.limit * 3, 150);
  const dateStart = parseFilterDate(filters.startDate);
  const dateEnd = parseFilterDate(filters.endDate);

  const whereClauses: string[] = [
    "payload_json IS NOT NULL",
    "source IN ('shopify', 'anymarket')",
  ];
  const baseValues: unknown[] = [];

  if (dateStart) {
    baseValues.push(dateStart);
    whereClauses.push(`received_at >= $${baseValues.length}`);
  }

  if (dateEnd) {
    baseValues.push(dateEnd);
    whereClauses.push(`received_at <= $${baseValues.length}`);
  }

  const readModelFilters: ReadModelFilters = {
    type: "income",
    sources: ["integration", "webhook"],
    marketplace: filters.marketplace,
    paymentMethod: filters.paymentMethod,
    startDate: filters.startDate,
    endDate: filters.endDate,
  };

  let scanOffset = 0;
  let skipped = 0;
  const pageItems: FinancialTransaction[] = [];
  let hasNext = false;

  while (true) {
    const queryValues = [...baseValues, chunkSize, scanOffset];
    const rows = await pool.query<MirrorRow>(
      `
        SELECT id, source, event_type, external_order_id, payload_json, received_at, mirror_updated_at, processing_status
        FROM mirror.raw_payloads
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY COALESCE(mirror_updated_at, received_at) DESC NULLS LAST, id DESC
        LIMIT $${baseValues.length + 1}
        OFFSET $${baseValues.length + 2}
      `,
      queryValues
    );

    if (rows.rows.length === 0) {
      break;
    }

    const filteredRows = filterTransactions(
      rows.rows
        .map(mapMirrorRow)
        .filter((item): item is FinancialTransaction => Boolean(item)),
      readModelFilters
    );

    for (const item of filteredRows) {
      if (skipped < targetSkip) {
        skipped += 1;
        continue;
      }

      if (pageItems.length < filters.limit) {
        pageItems.push(item);
        continue;
      }

      hasNext = true;
      break;
    }

    if (hasNext || rows.rows.length < chunkSize) {
      break;
    }

    scanOffset += chunkSize;
  }

  return {
    items: pageItems,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: targetSkip + pageItems.length + (hasNext ? 1 : 0),
      hasNext,
    },
  };
}