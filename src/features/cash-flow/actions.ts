import { z } from "zod";

import { computeCashFlow } from "@/features/cash-flow/service";
import type { CashFlowSummary } from "@/features/cash-flow/types";
import type { ActionResult } from "@/types/api";

const cashFlowFiltersSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  source: z.string().optional(),
  categoryId: z.string().optional(),
});

export async function getCashFlowAction(
  input: unknown
): Promise<ActionResult<CashFlowSummary>> {
  const parsed = cashFlowFiltersSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: "Filtros inválidos para fluxo de caixa." };
  }

  const summary = await computeCashFlow(parsed.data);
  return { success: true, data: summary };
}
