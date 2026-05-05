"use server";

import { z } from "zod";

import type { ActionResult } from "@/types/api";
import { runReconciliation } from "./service";
import type { ReconciliationResult } from "./types";

const FiltersSchema = z.object({
  days: z.number().int().min(1).max(365).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export async function runReconciliationAction(input: {
  days?: number;
  startDate?: string;
  endDate?: string;
} = {}): Promise<ActionResult<ReconciliationResult>> {
  const parsed = FiltersSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  try {
    const result = await runReconciliation(parsed.data);
    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro ao executar reconciliação.",
    };
  }
}
