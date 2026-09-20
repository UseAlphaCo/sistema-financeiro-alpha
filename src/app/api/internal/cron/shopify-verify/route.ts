import type { NextRequest } from "next/server";

import { logError, logInfo } from "@/core/observability/logger";
import { JOB_NAMES } from "@/features/integration/job-names";
import { withJobRun } from "@/features/integration/job-run-repository";
import { runShopifyPaymentResolutionJob } from "@/features/integration/shopify-payment-resolution-job";
import {
  runShopifyReconciliation,
  type ReconciliationSummary,
} from "@/features/integration/shopify-reconciliation";
import { buildVerificationReport, VERIFICATION_TIMEZONE } from "@/features/integration/shopify-value-verification";
import { dayWindowUtc } from "@/lib/date-utils";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export const runtime = "nodejs";

/**
 * Era a unica das quatro rotas de cron sem teto declarado, e por isso caia no
 * padrao da plataforma enquanto a v1 da verificacao levava ~850 s. Com o ledger
 * no lugar das ~1.700 chamadas REST o trabalho cai para poucos segundos, mas o
 * teto fica declarado assim mesmo: um estouro precisa aparecer como estouro em
 * integration.job_runs, nao como corte silencioso no meio.
 *
 * ORCAMENTO MEDIDO (20/09/2026, chamada real): 90 s de ponta a ponta, contra os
 * ~42 s de antes da reconciliacao. A diferenca e' a segunda busca paginada de
 * tenderTransactions, que cobre D-4..D-0 em vez de um dia so. Sobra 3,3x de
 * folga, e o teto de MAX_FIXES em shopify-reconciliation.ts limita o pior caso:
 * 60 correcoes x 500 ms do portao da Shopify = ~30 s a mais.
 */
export const maxDuration = 300;

// Escopo de alinhamento automatico quando a divergencia e considerada um
// alerta real (dia maduro). Reprocessa so o dia verificado, nao o backlog.
const AUTO_ALIGN_BATCH_SIZE = 200;

/**
 * Reconcilia sem poder derrubar a verificacao.
 *
 * A verificacao e' o sinal de saude que o painel publica; a reconciliacao e' um
 * conserto oportunista que fala com a Admin API. Deixar a segunda lancar
 * apagaria o relatorio inteiro do dia por causa de um 5xx da Shopify — e o
 * painel passaria a dizer "falhou" sobre a medicao, que na verdade correu bem.
 * Mesmo criterio da regra de ouro de job-run-repository: registrar (ou consertar)
 * nunca derruba o que estava sendo medido.
 */
async function reconciliarComSeguranca(
  requestId: string,
  report: Awaited<ReturnType<typeof buildVerificationReport>>
): Promise<ReconciliationSummary | { error: string }> {
  try {
    return await runShopifyReconciliation({
      endDate: report.date,
      latestDayIsMature: report.maturity.isMature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao reconciliar.";
    logError("shopify_reconciliation_failed", { requestId, date: report.date, error: message });
    return { error: message };
  }
}

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
// como alerta real quando o dia estiver maduro. Maturidade agora sao sinais de
// fila drenada (resolucao vazia, ledger cobrindo os pedidos materializados,
// materializacao rodada depois do dia fechar), e nao mais um proxy de horas que
// era falso por construcao no horario do cron — ver MaturitySignal.
//
// Sem parametro de data na rota — quem precisa checar outro dia usa o script
// CLI (npm run verify:shopify -- --date=...), que chama a mesma logica.
//
// DUAS CORRECOES COMPLEMENTARES, e nao redundantes:
//
//   auto-alinhamento  runShopifyPaymentResolutionJob, so para pedido que ainda
//                     NAO TEM resolucao nenhuma. So dispara em dia maduro com
//                     divergencia, e so sobre o dia verificado.
//   reconciliacao     runShopifyReconciliation, para pedido JA RESOLVIDO cujo
//                     rateio ficou com valor VELHO. Roda sempre, sobre D-1..D-3.
//
// A segunda existe porque a primeira nao alcanca o caso: uma captura que a
// Shopify registra dias depois nao muda o payload do mirror, entao
// `mirror_updated_at` nao se move e o predicado do job nunca reencontra o
// pedido. Os dois conjuntos sao disjuntos por construcao.
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!isAuthorized(request)) {
    return createApiError(requestId, "Nao autorizado.", 401);
  }

  try {
    const outcome = await withJobRun(JOB_NAMES.shopifyVerify, null, requestId, async () => {
      const report = await buildVerificationReport();
      const hasDivergence = report.metrics.some((metric) => metric.diverges);

      // Roda SEMPRE, inclusive quando o dia fecha: a janela dela e' D-1..D-3, e a
      // captura atrasada que ela persegue aparece justamente num dia que ja foi
      // dado por conferido. Condicionar a divergencia de D-1 deixaria passar
      // exatamente a classe que ela existe para fechar.
      const reconciliation = await reconciliarComSeguranca(requestId, report);

      if (!hasDivergence) {
        logInfo("shopify_verify_ok", { requestId, date: report.date, metrics: report.metrics });
        return { report, alert: "none" as const, alignment: undefined, reconciliation };
      }

      if (!report.maturity.isMature) {
        logInfo("shopify_verify_divergence_informational", {
          requestId,
          date: report.date,
          metrics: report.metrics,
          maturity: report.maturity,
        });
        return { report, alert: "informational" as const, alignment: undefined, reconciliation };
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

      return { report, alert: "divergence" as const, alignment, reconciliation };
    });

    return createApiSuccess(requestId, {
      report: outcome.report,
      alert: outcome.alert,
      ...(outcome.alignment === undefined ? {} : { alignment: outcome.alignment }),
      reconciliation: outcome.reconciliation,
    });
  } catch (error) {
    return createApiError(
      requestId,
      error instanceof Error ? error.message : "Falha ao verificar valores Sistema Financeiro vs Shopify.",
      500
    );
  }
}
