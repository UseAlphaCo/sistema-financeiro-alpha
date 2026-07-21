import type { NextRequest } from "next/server";

import { startWorkerSyncJob } from "@/features/integration/worker-sync-jobs";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export const runtime = "nodejs";

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
  // Poucas execucoes por invocacao: o cron dispara a cada 30 min e aguarda
  // o job terminar antes de responder (awaitCompletion), entao o trabalho
  // precisa caber com folga no timeout padrao da function serverless. A
  // fila avanca de forma incremental a cada ciclo de cron.
  const maxRuns = 2;

  try {
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
