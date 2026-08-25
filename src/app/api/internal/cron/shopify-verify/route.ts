import type { NextRequest } from "next/server";

import { logError, logInfo } from "@/core/observability/logger";
import { runShopifyPaymentResolutionJob } from "@/features/integration/shopify-payment-resolution-job";
import { buildVerificationReport, VERIFICATION_TIMEZONE } from "@/features/integration/shopify-value-verification";
import { dayWindowUtc } from "@/lib/date-utils";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export const runtime = "nodejs";

// Escopo de alinhamento automatico quando a divergencia e considerada um
// alerta real (dia maduro). Reprocessa so o dia verificado, nao o backlog.
const AUTO_ALIGN_BATCH_SIZE = 200;

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const bearer = request.headers.get("authorization");
  if (bearer === `Bearer ${expected}`) return true;

  const direct = request.headers.get("x-cron-secret");
  return direct === expected;
}

// Sempre verifica D-1 em America/Bahia — decisao deliberada (ver plano de
// 2026-07-27): checar contra um offset fixo de dia, mas so tratar divergencia
// como alerta real quando o sinal de maturidade (report.maturity.isMature)
// indicar que o dia ja teve tempo/completude suficiente de sincronizacao.
// Sem parametro de data na rota — quem precisa checar outro dia usa o script
// CLI (npm run verify:shopify -- --date=...), que chama a mesma logica.
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!isAuthorized(request)) {
    return createApiError(requestId, "Nao autorizado.", 401);
  }

  try {
    const report = await buildVerificationReport();
    const hasDivergence = report.metrics.some((metric) => metric.diverges);

    if (!hasDivergence) {
      logInfo("shopify_verify_ok", { requestId, date: report.date, metrics: report.metrics });
      return createApiSuccess(requestId, { report, alert: "none" as const });
    }

    if (!report.maturity.isMature) {
      logInfo("shopify_verify_divergence_informational", {
        requestId,
        date: report.date,
        metrics: report.metrics,
        maturity: report.maturity,
      });
      return createApiSuccess(requestId, { report, alert: "informational" as const });
    }

    logError("shopify_verify_divergence_alert", {
      requestId,
      date: report.date,
      metrics: report.metrics,
      maturity: report.maturity,
    });

    const window = dayWindowUtc(report.date, VERIFICATION_TIMEZONE);
    let alignment: Awaited<ReturnType<typeof runShopifyPaymentResolutionJob>> | { error: string };
    try {
      alignment = await runShopifyPaymentResolutionJob(AUTO_ALIGN_BATCH_SIZE, window.start);
    } catch (error) {
      alignment = { error: error instanceof Error ? error.message : "Falha ao tentar auto-alinhar." };
    }

    logInfo("shopify_verify_auto_align_result", { requestId, date: report.date, alignment });

    return createApiSuccess(requestId, { report, alert: "divergence" as const, alignment });
  } catch (error) {
    return createApiError(
      requestId,
      error instanceof Error ? error.message : "Falha ao verificar valores Sistema Financeiro vs Shopify.",
      500
    );
  }
}
