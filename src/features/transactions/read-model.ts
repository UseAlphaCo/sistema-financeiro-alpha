import { getPrismaClient } from "@/core/db/prisma-client";
import { getCorePool, queryMirrorRows } from "@/features/transactions/mirror-events-repository";
import { mapMirrorRow } from "@/features/transactions/mirror-order-mapper";
import {
  filterTransactions,
  MIRROR_SOURCES,
  mirrorCannotContribute,
  parseFilterDate,
  type MarketplaceReadModelFilters,
  type ReadModelFilters,
} from "@/features/transactions/read-model-filters";
import type {
  FinancialTransaction,
  ListTransactionsFilters,
  PaginatedTransactions,
} from "@/features/transactions/types";

/**
 * Read model financeiro: uniao do mirror (pedidos de marketplace) com
 * FinancialTransaction (lancamentos manuais/importados).
 *
 * O que era um arquivo de 819 linhas virou tres modulos com responsabilidade
 * separada -- mirror-order-mapper.ts (puro), mirror-events-repository.ts
 * (`pg`) e read-model-filters.ts (tipos e filtros em memoria). Aqui ficam
 * apenas a orquestracao e as tres assinaturas publicas, que nao mudaram.
 */

// Folga tolerada entre a data do pedido (occurredAt) e o momento em que a
// linha chegou no mirror (received_at) — cobre backfill/reprocessamento
// atrasado sem obrigar a varrer a tabela inteira ate "agora" a cada consulta.
const RECEIVED_AT_GRACE_MS = 21 * 24 * 60 * 60 * 1000;

async function listMirrorTransactions(filters: ReadModelFilters): Promise<FinancialTransaction[]> {
  if (mirrorCannotContribute(filters)) {
    return [];
  }

  const pool = getCorePool();
  if (!pool) return [];

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

export async function listMarketplaceReadModelPaginated(
  filters: MarketplaceReadModelFilters
): Promise<PaginatedTransactions> {
  const readModelFilters: ReadModelFilters = {
    type: "income",
    sources: [...MIRROR_SOURCES],
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
