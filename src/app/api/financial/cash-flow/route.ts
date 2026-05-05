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
      const params = Object.fromEntries(request.nextUrl.searchParams.entries());
      const result = await getCashFlowAction(params);

      if (!result.success) {
        return createApiError(requestId, result.error, 400);
      }

      return createApiSuccess(requestId, result.data);
    }
  );
}
