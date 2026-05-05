import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { runReconciliationAction } from "@/features/reconciliation/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

// POST /api/financial/reconciliation — executa e persiste snapshot
export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    { requireAuth: true, allowedRoles: ["admin", "financeiro"], rateLimit: 5, sensitive: true },
    async ({ requestId }) => {
      const body = await request.json().catch(() => ({})) as { days?: number; startDate?: string; endDate?: string };
      const result = await runReconciliationAction({
        days: body.days,
        startDate: body.startDate,
        endDate: body.endDate,
      });
      if (!result.success) return createApiError(requestId, result.error, 422);
      return createApiSuccess(requestId, result.data);
    }
  );
}

// GET /api/financial/reconciliation — executa reconciliação rápida (30 dias)
export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    { requireAuth: true, allowedRoles: ["admin", "financeiro"], rateLimit: 10, sensitive: true },
    async ({ requestId }) => {
      const { searchParams } = new URL(request.url);
      const days = parseInt(searchParams.get("days") ?? "30", 10) || 30;
      const result = await runReconciliationAction({ days });
      if (!result.success) return createApiError(requestId, result.error, 500);
      return createApiSuccess(requestId, result.data);
    }
  );
}

