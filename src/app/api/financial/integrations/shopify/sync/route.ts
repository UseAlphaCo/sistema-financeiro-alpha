import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { createApiError } from "@/shared/api/envelope";

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    { requireAuth: true, allowedRoles: ["admin", "financeiro"], rateLimit: 5, sensitive: true },
    async ({ requestId }) => {
      return createApiError(
        requestId,
        "Endpoint legado desativado. Use /api/financial/integrations/worker/start para sincronizacao via Worker.",
        410,
        { replacedBy: "/api/financial/integrations/worker/start" }
      );
    }
  );
}
