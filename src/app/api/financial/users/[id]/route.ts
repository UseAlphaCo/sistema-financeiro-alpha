import { NextRequest } from "next/server";

import { AppError } from "@/core/errors/app-error";
import { withApiSecurity } from "@/core/security/with-api-security";
import { deleteUserAction, resetUserPasswordAction, updateUserAction } from "@/features/users/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
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
      const { id } = await context.params;

      try {
        const user = await updateUserAction({ ...payload, id }, session);
        return createApiSuccess(requestId, user);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro ao atualizar usuario.";
        const status = error instanceof AppError ? error.status : 400;
        return createApiError(requestId, message, status);
      }
    }
  );
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin"],
      rateLimit: 20,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const { id } = await context.params;

      try {
        const user = await deleteUserAction({ id }, session);
        return createApiSuccess(requestId, user);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro ao excluir usuario.";
        const status = error instanceof AppError ? error.status : 400;
        return createApiError(requestId, message, status);
      }
    }
  );
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
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
      const { id } = await context.params;

      try {
        const result = await resetUserPasswordAction({ ...payload, id }, session);
        return createApiSuccess(requestId, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erro ao redefinir senha do usuario.";
        const status = error instanceof AppError ? error.status : 400;
        return createApiError(requestId, message, status);
      }
    }
  );
}
