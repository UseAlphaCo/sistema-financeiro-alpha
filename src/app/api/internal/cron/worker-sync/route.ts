import type { NextRequest } from "next/server";

import { startWorkerSyncJob } from "@/features/integration/worker-sync-jobs";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export const runtime = "nodejs";

/**
 * O job roda dentro da requisicao (awaitCompletion), porque a function pode
 * ser congelada assim que responde — fire-and-forget mataria o ciclo no meio.
 * Como a alternativa nao existe, o limite tem que ser declarado em vez de
 * herdado: sem isto vale o default da plataforma, e um ciclo que passe dele
 * e cortado sem registro.
 *
 * 60s cabe com folga no ciclo atual (descoberta incremental de
 * BATCH_SIZE * 2 linhas + drenagem de BATCH_SIZE, vezes maxRuns = 2). Ao
 * aumentar BATCH_SIZE ou maxRuns, revisar.
 */
export const maxDuration = 60;

type AllowedDays = 30 | 60 | 90;

function parseCronDays(value: string | undefined): AllowedDays {
  if (value === "30" || value === "60" || value === "90") {
    return Number(value) as AllowedDays;
  }

  return 30;
}

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const bearer = request.headers.get("authorization");
  if (bearer === `Bearer ${expected}`) return true;

  const direct = request.headers.get("x-cron-secret");
  if (direct === expected) return true;

  return false;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!isAuthorized(request)) {
    return createApiError(requestId, "Nao autorizado.", 401);
  }

  const days = parseCronDays(request.nextUrl.searchParams.get("days") ?? process.env.WORKER_CRON_DAYS);
  // Poucas execucoes por invocacao: o trabalho precisa caber com folga no
  // maxDuration declarado abaixo. A fila avanca de forma incremental a cada
  // ciclo de cron.
  const maxRuns = 2;

  try {
    // Sem backfillWindowDays: o ciclo automatico faz apenas descoberta
    // incremental por marca d'agua. A varredura por janela de dias e
    // exclusiva dos disparos manuais.
    const job = await startWorkerSyncJob({
      estimatedScopeDays: days,
      requestedBy: "cloudflare-cron",
      requestId,
      maxRuns,
      awaitCompletion: true,
    });

    return createApiSuccess(requestId, {
      jobId: job.id,
      status: job.status,
      mode: job.mode,
      estimatedScopeDays: job.estimatedScopeDays,
      startedAt: job.startedAt,
      maxRuns: job.maxRuns,
    });
  } catch (error) {
    return createApiError(
      requestId,
      error instanceof Error ? error.message : "Falha ao iniciar sincronizacao automatica.",
      500
    );
  }
}
