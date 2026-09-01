import { getPrismaClient } from "@/core/db/prisma-client";
import {
  listMaterializedOrders,
  type FinancialOrderRow,
} from "@/features/transactions/financial-orders-repository";
import {
  getCorePool,
  queryMirrorRows,
  queryShopifyGatewayPaymentsInWindow,
} from "@/features/transactions/mirror-events-repository";
import { mapMirrorRow, normalizeSearchTerm } from "@/features/transactions/mirror-order-mapper";
import { resolveCoverage } from "@/features/transactions/read-model-coverage";
import {
  filterTransactions,
  MIRROR_SOURCES,
  mirrorCannotContribute,
  normalizeMarketplaceToken,
  parseFilterDate,
  type MarketplaceReadModelFilters,
  type ReadModelFilters,
} from "@/features/transactions/read-model-filters";
import type {
  FinancialTransaction,
  ListTransactionsFilters,
  PaginatedTransactions,
  PaymentMethod,
} from "@/features/transactions/types";
import { isMaterializedReadModelEnabled } from "@/shared/read-model-config";

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

/**
 * Linha materializada -> FinancialTransaction, o objeto que as telas ja
 * consomem.
 *
 * `id` vem de mirror_row_id e cai em `source:order_key` quando nulo: a UI usa
 * esse campo como chave de lista, e chave nula ou repetida quebra a
 * reconciliacao de React sem erro visivel.
 *
 * Number() nos centavos mesmo com `::int` na consulta: o cast protege a query
 * (bigint volta como string no driver `pg`), o Number() protege quem consome se
 * alguem trocar o cast depois.
 */
function fromFinancialOrderRow(row: FinancialOrderRow): FinancialTransaction {
  const createdAt = (row.received_at ?? row.occurred_at).toISOString();

  return {
    id: row.mirror_row_id ?? `${row.source}:${row.order_key}`,
    externalSource: row.source,
    externalId: row.external_id,
    marketplace: row.marketplace,
    orderNumber: row.order_number,
    paymentMethodRaw: row.payment_method_raw,
    paymentMethodNormalized: row.payment_method_normalized as PaymentMethod | null,
    shippingCents: Number(row.shipping_cents),
    discountCents: Number(row.discount_cents),
    taxCents: Number(row.tax_cents),
    feeCents: Number(row.fee_cents),
    liquidCents: Number(row.liquid_cents),
    type: row.type as FinancialTransaction["type"],
    categoryId: null,
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    occurredAt: row.occurred_at.toISOString(),
    description: row.description,
    source: row.tx_source as FinancialTransaction["source"],
    status: row.status as FinancialTransaction["status"],
    createdBy: null,
    updatedBy: null,
    changeReason: null,
    createdAt,
    updatedAt: (row.source_updated_at ?? row.received_at ?? row.occurred_at).toISOString(),
    deletedAt: null,
  };
}

/**
 * Leitura pela tabela materializada. WHERE, ORDER BY, LIMIT e OFFSET sao do
 * banco -- e a diferenca em relacao ao caminho do mirror, que traz a janela
 * inteira de eventos e pagina em memoria.
 *
 * O piso de cobertura recorta o inicio e, em `none`, nem abre conexao: nao ha o
 * que consultar antes da data em que o dado comeca.
 */
async function listMaterializedTransactions(
  filters: ReadModelFilters,
  pagination?: { page: number; limit: number }
): Promise<{ items: FinancialTransaction[]; total: number }> {
  // Mesmo curto-circuito por filtros do caminho legado: as invariantes do
  // mapeamento (type income, categoryId null, source webhook/integration) valem
  // igual na tabela materializada.
  if (mirrorCannotContribute(filters)) {
    return { items: [], total: 0 };
  }

  const coverage = resolveCoverage(parseFilterDate(filters.startDate), parseFilterDate(filters.endDate));
  if (coverage.status === "none") {
    return { items: [], total: 0 };
  }

  const { rows, total } = await listMaterializedOrders({
    page: pagination?.page,
    limit: pagination?.limit ?? null,
    type: filters.type,
    status: filters.status,
    source: filters.source,
    sources: filters.sources,
    marketplace: normalizeMarketplaceToken(filters.marketplace) ?? undefined,
    paymentMethod: filters.paymentMethod,
    categoryId: filters.categoryId,
    startDate: coverage.start,
    endDate: coverage.end,
    search: filters.search ? normalizeSearchTerm(filters.search) : undefined,
  });

  return { items: rows.map(fromFinancialOrderRow), total };
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

/**
 * Todas as linhas do periodo, sem paginacao. Alimenta a agregacao do fluxo de
 * caixa, que hoje soma em JS.
 *
 * Com a flag ligada, a fonte passa a ser a tabela materializada: 26 colunas
 * pequenas por PEDIDO, em vez de payload_json de 10 a 30 KB por EVENTO. A
 * agregacao continua em JS de proposito nesta etapa -- move-la para SQL (secao
 * 2.6 do plano) e a etapa seguinte, e misturar as duas mudancas tornaria
 * impossivel saber qual delas causou uma divergencia de numero.
 */
export async function listFinancialReadModelTransactions(
  filters: ReadModelFilters
): Promise<FinancialTransaction[]> {
  const [coreItems, prismaItems] = await Promise.all([
    isMaterializedReadModelEnabled()
      ? listMaterializedTransactions(filters).then((result) => result.items)
      : listMirrorTransactions(filters),
    listPrismaTransactions(filters),
  ]);

  return [...coreItems, ...prismaItems].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt)
  );
}

export type ShopifyGatewayPayment = {
  gatewayRaw: string;
  amountCents: number;
  transactionCount: number;
};

/**
 * Pagamentos Shopify por gateway na janela, direto do ledger de rateio.
 *
 * E a base do "Pagamentos brutos por gateway" da Shopify: cada perna do
 * pagamento entra no dia do seu proprio processed_at, com o valor real daquele
 * gateway. Usado no Fluxo de Caixa para a linha Shopify de bySource e para a
 * parte Shopify de byPaymentMethod — as demais origens continuam vindo de
 * integration.financial_orders.
 */
export async function listShopifyGatewayPaymentsInWindow(
  start: Date,
  end: Date
): Promise<{ pagamentos: ShopifyGatewayPayment[]; diasCobertos: number }> {
  const rows = await queryShopifyGatewayPaymentsInWindow(start, end);
  return {
    pagamentos: rows.map((row) => ({
      gatewayRaw: row.gateway_raw,
      amountCents: Number(row.amount_cents),
      transactionCount: Number(row.transaction_count),
    })),
    diasCobertos: Number(rows[0]?.dias_cobertos ?? 0),
  };
}

export async function listFinancialReadModelPaginated(
  filters: ListTransactionsFilters
): Promise<PaginatedTransactions> {
  if (!isMaterializedReadModelEnabled()) {
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

  const offset = (filters.page - 1) * filters.limit;

  // Busca `offset + limit` de cada lado e recorta depois do merge. Nao da para
  // pedir `limit` de cada um: a pagina 2 do resultado unido pode ser toda de um
  // lado so. Ainda assim e limitado -- ao contrario do findMany sem `take` de
  // hoje, que traz a tabela inteira.
  const [core, prismaItems] = await Promise.all([
    listMaterializedTransactions(filters, { page: 1, limit: offset + filters.limit }),
    listPrismaTransactions(filters),
  ]);

  const merged = [...core.items, ...prismaItems].sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt)
  );

  const total = core.total + prismaItems.length;

  return {
    items: merged.slice(offset, offset + filters.limit),
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total,
      hasNext: offset + filters.limit < total,
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

  // Caminho materializado: a paginacao inteira e do banco. Esta e a tela que
  // mais ganha, porque e a unica que realmente pagina -- hoje ela traz o periodo
  // completo do mirror a cada troca de pagina.
  if (isMaterializedReadModelEnabled()) {
    const { items, total } = await listMaterializedTransactions(readModelFilters, {
      page: filters.page,
      limit: filters.limit,
    });

    return {
      items,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        hasNext: filters.page * filters.limit < total,
      },
    };
  }

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
