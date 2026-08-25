import type { Prisma } from "@prisma/client";

import { getPrismaClient } from "@/core/db/prisma-client";
import {
  type CreateTransactionInput,
  type FinancialTransaction,
  type ListTransactionsFilters,
  type PaginatedTransactions,
  type UpdateTransactionInput,
} from "@/features/transactions/types";
import {
  getPaymentMethodSearchTokens,
  transactionMatchesPaymentMethod,
} from "@/features/transactions/payment-method-filter";
import { getDailySnapshot } from "@/core/cache/dailySnapshot";
import { listFinancialReadModelPaginated } from "@/features/transactions/read-model";
import { isMirrorReadModelEnabled } from "@/shared/read-model-config";
import {
  addDaysToDayKey,
  endOfZonedDay,
  startOfZonedDay,
  zonedDayKey,
} from "@/lib/date-utils";

type DeleteInput = {
  id: string;
};

export interface TransactionsRepository {
  list(filters: ListTransactionsFilters): Promise<PaginatedTransactions>;
  findById(id: string): Promise<FinancialTransaction | null>;
  create(input: CreateTransactionInput, actorId: string): Promise<FinancialTransaction>;
  update(input: UpdateTransactionInput, actorId: string): Promise<FinancialTransaction | null>;
  remove(input: DeleteInput, actorId: string): Promise<boolean>;
  listWithCache?(filters: ListTransactionsFilters): Promise<PaginatedTransactions>;
}

/**
 * Detecta o range "ontem" para servir do snapshot diario em vez do banco.
 *
 * Comparava por dia UTC, e isso so funcionava porque o range chegava como
 * `00:00Z`->`23:59Z` -- dois erros que se cancelavam. Com as fronteiras
 * corrigidas para Brasilia o range chega como `03:00Z`->`02:59Z` do dia
 * seguinte, e a comparacao por dia UTC passaria a apontar para o dia errado sem
 * lancar erro nenhum: o cache serviria dado de outro dia em silencio.
 *
 * A chave devolvida continua sendo um instante `00:00:00Z`, porque
 * normalizeSnapshotDate (core/cache/dailySnapshot.ts) indexa por
 * `toISOString().slice(0, 10)`. O que mudou e QUAL dia, nao o formato.
 */
function isYesterdayRange(startDate?: string, endDate?: string): Date | null {
  if (!startDate || !endDate) return null;

  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  const yesterdayKey = addDaysToDayKey(zonedDayKey(new Date()), -1);

  const isStartYesterday = zonedDayKey(start) === yesterdayKey;
  const isEndYesterday = zonedDayKey(end) === yesterdayKey;
  return isStartYesterday && isEndYesterday
    ? new Date(`${yesterdayKey}T00:00:00.000Z`)
    : null;
}

class InMemoryTransactionsRepository implements TransactionsRepository {
  private items: FinancialTransaction[] = [];

  async list(filters: ListTransactionsFilters): Promise<PaginatedTransactions> {
    const filtered = this.items
      .filter((item) => item.deletedAt === null)
      .filter((item) => {
        if (filters.type && item.type !== filters.type) return false;
        if (filters.source && item.source !== filters.source) return false;
        if (filters.sources && filters.sources.length > 0 && !filters.sources.includes(item.source)) {
          return false;
        }
        if (filters.status && item.status !== filters.status) return false;
        if (filters.marketplace && item.marketplace !== filters.marketplace) return false;
        if (
          filters.paymentMethod &&
          !transactionMatchesPaymentMethod(
            {
              paymentMethodNormalized: item.paymentMethodNormalized,
              paymentMethodRaw: item.paymentMethodRaw,
            },
            filters.paymentMethod
          )
        ) {
          return false;
        }
        if (filters.categoryId && item.categoryId !== filters.categoryId) {
          return false;
        }

        if (filters.startDate && new Date(item.occurredAt) < new Date(filters.startDate)) {
          return false;
        }

        if (filters.endDate && new Date(item.occurredAt) > new Date(filters.endDate)) {
          return false;
        }

        if (filters.search) {
          const haystack = `${item.description ?? ""} ${item.externalId ?? ""}`.toLowerCase();
          return haystack.includes(filters.search.toLowerCase());
        }

        return true;
      })
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    const offset = (filters.page - 1) * filters.limit;
    const pageItems = filtered.slice(offset, offset + filters.limit);

    return {
      items: pageItems,
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total: filtered.length,
        hasNext: offset + filters.limit < filtered.length,
      },
    };
  }

  async findById(id: string): Promise<FinancialTransaction | null> {
    const item = this.items.find((entry) => entry.id === id && entry.deletedAt === null);
    return item ?? null;
  }

  async create(input: CreateTransactionInput, actorId: string): Promise<FinancialTransaction> {
    const now = new Date().toISOString();
    const item: FinancialTransaction = {
      id: crypto.randomUUID(),
      externalSource: input.externalSource ?? null,
      externalId: input.externalId ?? null,
      marketplace: input.marketplace ?? null,
      orderNumber: input.orderNumber ?? null,
      paymentMethodRaw: input.paymentMethodRaw ?? null,
      paymentMethodNormalized: input.paymentMethodNormalized ?? null,
      shippingCents: input.shippingCents ?? 0,
      discountCents: input.discountCents ?? 0,
      taxCents: input.taxCents ?? 0,
      feeCents: input.feeCents ?? 0,
      liquidCents: Math.max(
        0,
        input.amountCents -
          (input.shippingCents ?? 0) -
          (input.discountCents ?? 0) -
          (input.taxCents ?? 0) -
          (input.feeCents ?? 0)
      ),
      type: input.type,
      categoryId: input.categoryId ?? null,
      amountCents: input.amountCents,
      currency: input.currency ?? "BRL",
      occurredAt: input.occurredAt,
      description: input.description ?? null,
      source: input.source,
      status: input.status ?? "pending",
      createdBy: actorId,
      updatedBy: actorId,
      changeReason: input.changeReason ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };

    this.items.push(item);
    return item;
  }

  async update(input: UpdateTransactionInput, actorId: string): Promise<FinancialTransaction | null> {
    const index = this.items.findIndex((item) => item.id === input.id && item.deletedAt === null);
    if (index < 0) return null;

    const current = this.items[index];
    const next: FinancialTransaction = {
      ...current,
      categoryId: input.categoryId !== undefined ? input.categoryId : current.categoryId,
      amountCents: input.amountCents ?? current.amountCents,
      occurredAt: input.occurredAt ?? current.occurredAt,
      description: input.description !== undefined ? input.description : current.description,
      status: input.status ?? current.status,
      changeReason: input.changeReason ?? current.changeReason,
      updatedBy: actorId,
      updatedAt: new Date().toISOString(),
    };

    this.items[index] = next;
    return next;
  }

  async remove(input: DeleteInput, actorId: string): Promise<boolean> {
    const index = this.items.findIndex((item) => item.id === input.id && item.deletedAt === null);
    if (index < 0) return false;

    this.items[index] = {
      ...this.items[index],
      deletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    };

    return true;
  }

  async listWithCache(filters: ListTransactionsFilters): Promise<PaginatedTransactions> {
    const yesterday = isYesterdayRange(filters.startDate, filters.endDate);

    if (yesterday) {
      try {
        const snapshot = await getDailySnapshot(yesterday);
        if (snapshot && Array.isArray(snapshot.data)) {
          return {
            items: snapshot.data as FinancialTransaction[],
            pagination: {
              page: 1,
              limit: snapshot.data.length,
              total: snapshot.data.length,
              hasNext: false,
            },
          };
        }
      } catch {
        // Em cutover, tabela de snapshot pode não existir no banco corrente.
      }
    }
    // Fallback para consulta normal
    return this.list(filters);
  }
}

function mapDbTransaction(item: {
  id: string;
  externalSource: string | null;
  externalId: string | null;
  marketplace?: string | null;
  orderNumber?: string | null;
  paymentMethodRaw?: string | null;
  paymentMethodNormalized?: string | null;
  shippingCents?: number | null;
  discountCents?: number | null;
  taxCents?: number | null;
  feeCents?: number | null;
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
}): FinancialTransaction {
  return {
    id: item.id,
    externalSource: item.externalSource,
    externalId: item.externalId,
    marketplace: item.marketplace ?? null,
    orderNumber: item.orderNumber ?? null,
    paymentMethodRaw: item.paymentMethodRaw ?? null,
    paymentMethodNormalized:
      (item.paymentMethodNormalized as FinancialTransaction["paymentMethodNormalized"]) ?? null,
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
    deletedAt: item.deletedAt ? item.deletedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

class PrismaTransactionsRepository implements TransactionsRepository {
  async listWithCache(filters: ListTransactionsFilters): Promise<PaginatedTransactions> {
    const yesterday = isYesterdayRange(filters.startDate, filters.endDate);

    if (yesterday) {
      try {
        const snapshot = await getDailySnapshot(yesterday);
        if (snapshot && Array.isArray(snapshot.data)) {
          return {
            items: snapshot.data as FinancialTransaction[],
            pagination: {
              page: 1,
              limit: snapshot.data.length,
              total: snapshot.data.length,
              hasNext: false,
            },
          };
        }
      } catch {
        // Em cutover, tabela de snapshot pode não existir no banco corrente.
      }
    }

    return this.list(filters);
  }

  async list(filters: ListTransactionsFilters): Promise<PaginatedTransactions> {
    const useMirrorReadModel = isMirrorReadModelEnabled();

    if (useMirrorReadModel) {
      try {
        return await listFinancialReadModelPaginated(filters);
      } catch {
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
    }

    const prisma = getPrismaClient();

    const where: Prisma.FinancialTransactionWhereInput = {
      deletedAt: null,
    };
    const andConditions: Prisma.FinancialTransactionWhereInput[] = [];

    if (filters.type) where.type = filters.type;
    if (filters.source) where.source = filters.source;
    if (filters.sources && filters.sources.length > 0) {
      where.source = { in: filters.sources };
    }
    if (filters.status) where.status = filters.status;
    if (filters.marketplace) {
      (where as Prisma.FinancialTransactionWhereInput & { marketplace?: string }).marketplace =
        filters.marketplace;
    }
    if (filters.paymentMethod) {
      const tokenMatches: Prisma.FinancialTransactionWhereInput[] = getPaymentMethodSearchTokens(
        filters.paymentMethod
      ).map((token) => ({
        paymentMethodRaw: { contains: token, mode: "insensitive" },
      }));

      andConditions.push({
        OR: [
          { paymentMethodNormalized: filters.paymentMethod },
          ...tokenMatches,
        ],
      });
    }
    if (filters.categoryId) where.categoryId = filters.categoryId;

    if (filters.startDate || filters.endDate) {
      where.occurredAt = {};
      if (filters.startDate) where.occurredAt.gte = new Date(filters.startDate);
      if (filters.endDate) where.occurredAt.lte = new Date(filters.endDate);
    }

    if (filters.search) {
      andConditions.push({
        OR: [
        { description: { contains: filters.search, mode: "insensitive" } },
        { externalId: { contains: filters.search, mode: "insensitive" } },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const skip = (filters.page - 1) * filters.limit;
    const [total, rows] = await Promise.all([
      prisma.financialTransaction.count({ where }),
      prisma.financialTransaction.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip,
        take: filters.limit,
      }),
    ]);

    return {
      items: rows.map(mapDbTransaction),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        total,
        hasNext: skip + filters.limit < total,
      },
    };
  }

  async findById(id: string): Promise<FinancialTransaction | null> {
    const prisma = getPrismaClient();
    const row = await prisma.financialTransaction.findUnique({ where: { id } });
    if (!row || row.deletedAt) {
      return null;
    }

    return mapDbTransaction(row);
  }

  async create(input: CreateTransactionInput, actorId: string): Promise<FinancialTransaction> {
    const prisma = getPrismaClient();
    const row = await prisma.financialTransaction.create({
      data: {
        externalSource: input.externalSource ?? null,
        externalId: input.externalId ?? null,
        marketplace: input.marketplace ?? null,
        orderNumber: input.orderNumber ?? null,
        paymentMethodRaw: input.paymentMethodRaw ?? null,
        paymentMethodNormalized: input.paymentMethodNormalized ?? null,
        shippingCents: input.shippingCents ?? 0,
        discountCents: input.discountCents ?? 0,
        taxCents: input.taxCents ?? 0,
        feeCents: input.feeCents ?? 0,
        type: input.type,
        categoryId: input.categoryId ?? null,
        amountCents: input.amountCents,
        currency: input.currency ?? "BRL",
        occurredAt: new Date(input.occurredAt),
        description: input.description ?? null,
        source: input.source,
        status: input.status ?? "pending",
        createdBy: actorId,
        updatedBy: actorId,
        changeReason: input.changeReason ?? null,
      },
    });

    return mapDbTransaction(row);
  }

  async update(input: UpdateTransactionInput, actorId: string): Promise<FinancialTransaction | null> {
    const prisma = getPrismaClient();
    const existing = await prisma.financialTransaction.findUnique({ where: { id: input.id } });
    if (!existing || existing.deletedAt) return null;

    const row = await prisma.financialTransaction.update({
      where: { id: input.id },
      data: {
        categoryId: input.categoryId !== undefined ? input.categoryId : undefined,
        amountCents: input.amountCents,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
        description: input.description !== undefined ? input.description : undefined,
        status: input.status,
        changeReason: input.changeReason,
        updatedBy: actorId,
      },
    });

    return mapDbTransaction(row);
  }

  async remove(input: DeleteInput, actorId: string): Promise<boolean> {
    const prisma = getPrismaClient();
    const existing = await prisma.financialTransaction.findUnique({ where: { id: input.id } });
    if (!existing || existing.deletedAt) return false;

    await prisma.financialTransaction.update({
      where: { id: input.id },
      data: {
        deletedAt: new Date(),
        updatedBy: actorId,
      },
    });

    return true;
  }
}

const globalStore = globalThis as typeof globalThis & {
  __transactionsRepository?: TransactionsRepository;
};

export function getTransactionsRepository(): TransactionsRepository {
  if (!globalStore.__transactionsRepository) {
    const useDatabase = Boolean(process.env.DATABASE_URL);
    globalStore.__transactionsRepository = useDatabase
      ? new PrismaTransactionsRepository()
      : new InMemoryTransactionsRepository();
  }

  return globalStore.__transactionsRepository;
}

// Retorna todas as transações de ontem (para snapshot)
export async function listTransactionsForYesterday() {
  const prisma = getPrismaClient();
  // Dia de Brasilia, igual ao que isYesterdayRange procura no cache. Em UTC as
  // duas pontas discordariam entre 21:00 e 23:59 de Brasilia, e o snapshot
  // gravado nunca seria encontrado pela leitura.
  const yesterdayKey = addDaysToDayKey(zonedDayKey(new Date()), -1);
  const start = startOfZonedDay(yesterdayKey);
  const end = endOfZonedDay(yesterdayKey);
  const rows = await prisma.financialTransaction.findMany({
    where: {
      deletedAt: null,
      occurredAt: {
        gte: start,
        lte: end,
      },
    },
    orderBy: { occurredAt: "desc" },
  });
  return rows.map(mapDbTransaction);
}
