import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { syncShopifyOrders } from "@/features/integration/shopify-orders-sync";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    { requireAuth: true, allowedRoles: ["admin", "financeiro"], rateLimit: 5, sensitive: true },
    async ({ requestId }) => {
      const storeUrl = process.env.SHOPIFY_STORE_URL;
      const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

      if (!storeUrl || !accessToken) {
        return createApiError(
          requestId,
          "Variaveis SHOPIFY_STORE_URL e SHOPIFY_ACCESS_TOKEN nao configuradas.",
          503
        );
      }

      const body = await request.json().catch(() => ({})) as Record<string, unknown>;
      const days = typeof body.days === "number" ? Math.min(Math.max(1, body.days), 90) : 30;

      const result = await syncShopifyOrders(storeUrl, accessToken, days);

      if (!result.success) {
        return createApiError(requestId, result.error, 502);
      }

      return createApiSuccess(requestId, result.data);
    }
  );
}
