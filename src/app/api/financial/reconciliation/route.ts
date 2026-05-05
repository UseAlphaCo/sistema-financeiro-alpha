import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { createApiSuccess } from "@/shared/api/envelope";

export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId }) => {
      return createApiSuccess(requestId, {
        status: "pending",
        issues: [],
      });
    }
  );
}
