import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import {
  createTransactionAction,
  deleteTransactionAction,
  listTransactionsAction,
  updateTransactionAction,
} from "@/features/transactions/actions";
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
      const query = Object.fromEntries(request.nextUrl.searchParams.entries());
      const result = await listTransactionsAction(query);

      return createApiSuccess(requestId, {
        items: result.items,
        pagination: result.pagination,
      });
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
      const result = await createTransactionAction(payload, session?.id ?? "unknown");

      if (!result.success) {
        return createApiError(requestId, result.error, 400);
      }

      return createApiSuccess(requestId, result.data, {}, 201);
    }
  );
}

export async function PATCH(request: NextRequest) {
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
      const result = await updateTransactionAction(payload, session?.id ?? "unknown");

      if (!result.success) {
        const status = result.error.includes("nao encontrada") ? 404 : 400;
        return createApiError(requestId, result.error, status);
      }

      return createApiSuccess(requestId, result.data);
    }
  );
}

export async function DELETE(request: NextRequest) {
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
      const result = await deleteTransactionAction(payload, session?.id ?? "unknown");

      if (!result.success) {
        const status = result.error.includes("nao encontrada") ? 404 : 400;
        return createApiError(requestId, result.error, status);
      }

      return createApiSuccess(requestId, result.data);
    }
  );
}
