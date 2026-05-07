import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import * as actions from "@/features/categories/actions";
import { createApiSuccess } from "@/shared/api/envelope";

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
      const categories = await actions.listCategories();
      return createApiSuccess(requestId, categories);
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
    async ({ requestId }) => {
      const body = await request.json();
      const category = await actions.createCategory(body);
      return createApiSuccess(requestId, category, {}, 201);
    }
  );
}
