import { NextRequest } from "next/server";

import { AppError } from "@/core/errors/app-error";
import { withApiSecurity } from "@/core/security/with-api-security";
import { applyDivergenceAction } from "@/features/integration/divergence-queue";
import { createApiSuccess } from "@/shared/api/envelope";

/**
 * Acao do operador sobre uma divergencia: `reprocessar` (volta para a proxima
 * rodada) ou `aceitar` (fecha por decisao humana, registrando quem).
 *
 * POST com `{ action, note? }` em vez de um verbo por rota: as duas acoes
 * compartilham validacao, autorizacao e o tratamento de "ja fechou".
 */
export async function POST(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      // requireAuth ja garantiu a sessao; a checagem existe para o tipo, e para
      // o aceite nunca ser gravado sem autor.
      if (!session) throw new AppError("Nao autenticado.", 401, "UNAUTHENTICATED");

      const { orderId } = await context.params;
      const body: unknown = await request.json().catch(() => null);
      const updated = await applyDivergenceAction(orderId, body, { email: session.email });

      return createApiSuccess(requestId, updated);
    }
  );
}
