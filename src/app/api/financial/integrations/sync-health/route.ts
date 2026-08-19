import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { getSyncSweepStatus } from "@/features/integration/worker-sync-jobs";
import { createApiSuccess } from "@/shared/api/envelope";

/**
 * Saude da sincronizacao OMS -> mirror, independente de existir um job.
 *
 * Existe separada de worker/status de proposito. worker/status responde sobre
 * um JOB: quando o cron parou de produzir jobs, em 11/08, a tela nao tinha o
 * que mostrar e ficou silenciosa -- enquanto o mirror seguia com 51% das linhas
 * que deveria ter. Esta rota responde sobre o ESTADO DO ESPELHO, e responde
 * mesmo quando nada esta rodando (que e justamente o caso em que importa).
 *
 * Le apenas tabelas do CORE. Nao toca o OMS, onde um COUNT(*) por fonte custa
 * 12,5 s -- por isso pode ser consultada a cada abertura da tela.
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
    async ({ requestId }) => {
      const sweep = await getSyncSweepStatus();

      const audit = sweep.cursors.find((cursor) => cursor.pass === "audit");
      const auditProgressPct =
        audit && audit.lapEndBlock
          ? Math.round((audit.nextBlock / audit.lapEndBlock) * 1000) / 10
          : null;

      return createApiSuccess(requestId, {
        ...sweep,
        auditProgressPct,
        /**
         * Regra das duas voltas: uma volta fechada NAO prova completude --
         * linhas migram de pagina em UPDATE nao-HOT e ha a janela MVCC, e as
         * duas se resolvem na volta seguinte. So a partir de duas voltas
         * limpas a afirmacao se sustenta.
         */
        completenessProven: (audit?.lapNumber ?? 0) >= 2,
      });
    }
  );
}
