import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { getCashFlowAction } from "@/features/cash-flow/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 60,
      sensitive: true,
    },
    async ({ requestId }) => {
      const days = request.nextUrl.searchParams.get("days");
      const result = await getCashFlowAction({ days: days ? Number(days) : 30 });

      if (!result.success) {
        return createApiError(requestId, result.error, 400);
      }

      const {
        period,
        totalIncomeCents,
        totalExpenseCents,
        bySource,
        byPaymentMethod,
        previousPeriod,
      } = result.data;

      return createApiSuccess(requestId, {
        revenue: totalIncomeCents,
        expenses: totalExpenseCents,
        period: `${period.days}d`,
        periodStart: period.startDate,
        periodEnd: period.endDate,
        bySource,
        byPaymentMethod,
        previousPeriod,
      });
    }
  );
}
