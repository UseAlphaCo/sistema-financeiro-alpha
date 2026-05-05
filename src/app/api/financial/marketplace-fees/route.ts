import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import {
  createMarketplaceFeeAction,
  listMarketplaceFeesAction,
} from "@/features/marketplace-fees/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 60,
    },
    async ({ requestId }) => {
      const params = Object.fromEntries(request.nextUrl.searchParams.entries());
      const result = await listMarketplaceFeesAction(params);

      if (!result.success) {
        return createApiError(requestId, result.error, 400);
      }

      return createApiSuccess(requestId, result.data);
    }
  );
}

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const payload = await request.json();
      const result = await createMarketplaceFeeAction(payload, session?.id ?? "unknown");

      if (!result.success) {
        return createApiError(requestId, result.error, 400);
      }

      return createApiSuccess(requestId, result.data, {}, 201);
    }
  );
}
