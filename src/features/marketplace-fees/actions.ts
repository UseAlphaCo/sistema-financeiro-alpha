import { marketplaceFeesRepository } from "@/features/marketplace-fees/repository";
import {
  createMarketplaceFeeSchema,
  listMarketplaceFeesSchema,
} from "@/features/marketplace-fees/validations";
import type { MarketplaceFee } from "@/features/marketplace-fees/types";
import type { ActionResult } from "@/types/api";

export async function listMarketplaceFeesAction(
  input: unknown
): Promise<ActionResult<MarketplaceFee[]>> {
  const parsed = listMarketplaceFeesSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Filtros inválidos para listagem de taxas." };
  }

  const items = await marketplaceFeesRepository.list(parsed.data);
  return { success: true, data: items };
}

export async function createMarketplaceFeeAction(
  input: unknown,
  actorId: string
): Promise<ActionResult<{ id: string }>> {
  const parsed = createMarketplaceFeeSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Payload inválido para criação de taxa." };
  }

  const created = await marketplaceFeesRepository.create(parsed.data, actorId);
  return { success: true, data: { id: created.id } };
}
