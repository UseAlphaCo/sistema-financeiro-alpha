export const MARKETPLACES = ["shopify", "mercado_livre", "shopee", "amazon"] as const;
export const FEE_TYPES = ["commission", "fixed", "payment_gateway", "shipping", "tax"] as const;

export type Marketplace = (typeof MARKETPLACES)[number];
export type FeeType = (typeof FEE_TYPES)[number];

export type MarketplaceFee = {
  id: string;
  marketplace: Marketplace;
  feeType: FeeType;
  ratePercent: number;
  fixedCents: number;
  currency: string;
  effectiveFrom: string;
  effectiveUntil: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateMarketplaceFeeInput = {
  marketplace: Marketplace;
  feeType: FeeType;
  ratePercent: number;
  fixedCents?: number;
  currency?: string;
  effectiveFrom: string;
  effectiveUntil?: string;
};

export type ListMarketplaceFeesFilters = {
  marketplace?: Marketplace;
  feeType?: FeeType;
  activeAt?: string;
};
