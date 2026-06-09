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

  const days = parseCronDays(process.env.WORKER_CRON_DAYS);
  const maxRuns = 20;

  try {
    const job = await startWorkerSyncJob({
      estimatedScopeDays: days,
      requestedBy: "vercel-cron",
      requestId,
      maxRuns,
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
