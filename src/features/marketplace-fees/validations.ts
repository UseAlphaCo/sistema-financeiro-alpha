import { z } from "zod";

import { MARKETPLACES, FEE_TYPES } from "@/features/marketplace-fees/types";

export const createMarketplaceFeeSchema = z.object({
  marketplace: z.enum(MARKETPLACES),
  feeType: z.enum(FEE_TYPES),
  ratePercent: z.number().min(0).max(100),
  fixedCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  effectiveFrom: z.string().datetime(),
  effectiveUntil: z.string().datetime().optional(),
});

export const listMarketplaceFeesSchema = z.object({
  marketplace: z.enum(MARKETPLACES).optional(),
  feeType: z.enum(FEE_TYPES).optional(),
  activeAt: z.string().datetime().optional(),
});
