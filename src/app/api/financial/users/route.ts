import { NextRequest } from "next/server";

import { AppError } from "@/core/errors/app-error";
import { withApiSecurity } from "@/core/security/with-api-security";
import { createUserAction, listUsersAction } from "@/features/users/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const users = await listUsersAction(session);
      return createApiSuccess(requestId, { items: users });
    }
  );
}

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin"],
      rateLimit: 20,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const payload = await request.json();
      try {
        const result = await createUserAction(payload, session);
        return createApiSuccess(requestId, result, {}, 201);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro ao criar usuario.";
        const status = error instanceof AppError ? error.status : 400;
        return createApiError(requestId, message, status);
      }
    }
  );
}
