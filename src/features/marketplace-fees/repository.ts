import { getPrismaClient } from "@/core/db/prisma-client";
import type {
  CreateMarketplaceFeeInput,
  ListMarketplaceFeesFilters,
  Marketplace,
  MarketplaceFee,
  FeeType,
} from "@/features/marketplace-fees/types";

function mapDbFee(item: {
  id: string;
  marketplace: string;
  feeType: string;
  ratePercent: { toNumber(): number };
  fixedCents: number;
  currency: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MarketplaceFee {
  return {
    id: item.id,
    marketplace: item.marketplace as Marketplace,
    feeType: item.feeType as FeeType,
    ratePercent: item.ratePercent.toNumber(),
    fixedCents: item.fixedCents,
    currency: item.currency,
    effectiveFrom: item.effectiveFrom.toISOString(),
    effectiveUntil: item.effectiveUntil ? item.effectiveUntil.toISOString() : null,
    createdBy: item.createdBy,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export interface MarketplaceFeesRepository {
  list(filters: ListMarketplaceFeesFilters): Promise<MarketplaceFee[]>;
  create(input: CreateMarketplaceFeeInput, actorId: string): Promise<MarketplaceFee>;
  findActiveByMarketplace(marketplace: Marketplace, at: Date): Promise<MarketplaceFee[]>;
}

class PrismaMarketplaceFeesRepository implements MarketplaceFeesRepository {
  async list(filters: ListMarketplaceFeesFilters): Promise<MarketplaceFee[]> {
    const db = getPrismaClient();

    const where: Record<string, unknown> = {};

    if (filters.marketplace) {
      where.marketplace = filters.marketplace;
    }
    if (filters.feeType) {
      where.feeType = filters.feeType;
    }
    if (filters.activeAt) {
      const at = new Date(filters.activeAt);
      where.effectiveFrom = { lte: at };
      where.OR = [{ effectiveUntil: null }, { effectiveUntil: { gte: at } }];
    }

    const items = await db.marketplaceFee.findMany({
      where,
      orderBy: [{ marketplace: "asc" }, { effectiveFrom: "desc" }],
    });

    return items.map(mapDbFee);
  }

  async create(
    input: CreateMarketplaceFeeInput,
    actorId: string
  ): Promise<MarketplaceFee> {
    const db = getPrismaClient();

    const item = await db.marketplaceFee.create({
      data: {
        marketplace: input.marketplace,
        feeType: input.feeType,
        ratePercent: input.ratePercent,
        fixedCents: input.fixedCents ?? 0,
        currency: input.currency ?? "BRL",
        effectiveFrom: new Date(input.effectiveFrom),
        effectiveUntil: input.effectiveUntil ? new Date(input.effectiveUntil) : null,
        createdBy: actorId,
      },
    });

    return mapDbFee(item);
  }

  async findActiveByMarketplace(
    marketplace: Marketplace,
    at: Date
  ): Promise<MarketplaceFee[]> {
    const db = getPrismaClient();

    const items = await db.marketplaceFee.findMany({
      where: {
        marketplace,
        effectiveFrom: { lte: at },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: at } }],
      },
      orderBy: { feeType: "asc" },
    });

    return items.map(mapDbFee);
  }
}

export const marketplaceFeesRepository: MarketplaceFeesRepository =
  new PrismaMarketplaceFeesRepository();
