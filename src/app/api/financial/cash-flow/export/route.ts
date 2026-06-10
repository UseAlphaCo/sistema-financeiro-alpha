import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import {
  startCashFlowExportJob,
  type CashFlowExportFilters,
  type CashFlowExportFormat,
} from "@/features/cash-flow/export-jobs";
import { PAYMENT_METHODS, type PaymentMethod } from "@/features/transactions/types";
import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/date-utils";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

function normalizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  return value;
}

function parseBody(input: unknown): { format: CashFlowExportFormat; filters: CashFlowExportFilters } {
  const payload = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const format = payload.format === "xlsx" ? "xlsx" : "csv";

  const filtersInput = (payload.filters && typeof payload.filters === "object"
    ? payload.filters
    : {}) as Record<string, unknown>;

  const presetRaw = typeof filtersInput.preset === "string" ? filtersInput.preset : undefined;
  const paymentMethodRaw =
    typeof filtersInput.paymentMethod === "string" ? filtersInput.paymentMethod : undefined;

  const filters: CashFlowExportFilters = {
    preset: PERIOD_PRESETS.includes(presetRaw as PeriodPreset)
      ? (presetRaw as PeriodPreset)
      : undefined,
    paymentMethod: PAYMENT_METHODS.includes(paymentMethodRaw as PaymentMethod)
      ? (paymentMethodRaw as PaymentMethod)
      : undefined,
    startDate: normalizeDate(filtersInput.startDate),
    endDate: normalizeDate(filtersInput.endDate),
  };

  return { format, filters };
}

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 10,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      try {
        const body = await request.json().catch(() => ({}));
        const { format, filters } = parseBody(body);

        const job = await startCashFlowExportJob({
          format,
          filters,
          requestedBy: session?.email ?? null,
          requestId,
        });

        return createApiSuccess(
          requestId,
          {
            jobId: job.id,
            status: job.status,
            format: job.format,
            startedAt: job.startedAt,
            processedRows: job.processedRows,
            totalRows: job.totalRows,
          },
          { phase: "cash_flow_export_start" }
        );
      } catch (error) {
        return createApiError(
          requestId,
          error instanceof Error
            ? error.message
            : "Falha ao iniciar exportacao do fluxo de caixa.",
          500,
          { phase: "cash_flow_export_start" }
        );
      }
    }
  );
}
