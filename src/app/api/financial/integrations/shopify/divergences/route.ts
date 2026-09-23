import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { getDivergenceQueue } from "@/features/integration/divergence-queue";
import { createApiSuccess } from "@/shared/api/envelope";

/**
 * Fila de divergencias abertas entre o ledger e a Shopify, por pedido.
 *
 * Sob /api/financial, e nao /api/internal: este e' o caminho de USUARIO, com
 * sessao e role. /api/internal esta em FROZEN_API_PREFIXES e autentica por
 * CRON_SECRET, que e' credencial de maquina.
 */
export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 60,
      sensitive: true,
    },
    async ({ requestId }) => createApiSuccess(requestId, await getDivergenceQueue())
  );
}
