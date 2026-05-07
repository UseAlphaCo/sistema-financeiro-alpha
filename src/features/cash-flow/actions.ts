import { z } from "zod";

import { computeCashFlow } from "@/features/cash-flow/service";
import { PAYMENT_METHODS } from "@/features/transactions/types";
import { PERIOD_PRESETS } from "@/lib/date-utils";
import type { CashFlowSummary } from "@/features/cash-flow/types";
import type { ActionResult } from "@/types/api";

const dateFilterSchema = z.union([
  z.string().datetime(),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
]);

const cashFlowFiltersSchema = z.object({
  preset: z.enum(PERIOD_PRESETS).optional(),
  days: z.coerce.number().int().min(1).max(365).optional(),
  startDate: dateFilterSchema.optional(),
  endDate: dateFilterSchema.optional(),
  source: z.string().optional(),
  categoryId: z.string().optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
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
