import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import * as actions from "@/features/categories/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 60,
      sensitive: true,
    },
    async ({ requestId }) => {
      const { id } = await context.params;
      const category = await actions.getCategoryById(id);

      if (!category) {
        return createApiError(requestId, "Categoria nao encontrada.", 404);
      }

      return createApiSuccess(requestId, category);
    }
  );
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId }) => {
      const { id } = await context.params;
      const body = await request.json();
      const updated = await actions.updateCategory({ id, ...body });

      return createApiSuccess(requestId, updated);
    }
  );
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId }) => {
      const { id } = await context.params;
      const deleted = await actions.deleteCategory(id);
      return createApiSuccess(requestId, deleted);
    }
  );
}
