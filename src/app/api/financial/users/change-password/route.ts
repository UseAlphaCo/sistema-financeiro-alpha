import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { verifyAndChangePassword } from "@/features/users/repository";
import { changePasswordSchema } from "@/features/users/validations";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 20,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const payload = await request.json();
      const parsed = changePasswordSchema.safeParse(payload);

      if (!parsed.success) {
        return createApiError(requestId, "Payload invalido para alteracao de senha.", 400);
      }

      const changed = await verifyAndChangePassword({
        userId: session!.id,
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
      });

      if (!changed) {
        return createApiError(requestId, "Senha atual invalida.", 400);
      }

      return createApiSuccess(requestId, { changed: true, email: session!.email });
    }
  );
}
