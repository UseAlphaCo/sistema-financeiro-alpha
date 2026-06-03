import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { startWorkerSyncJob } from "@/features/integration/worker-sync-jobs";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

const ALLOWED_RETROACTIVE_DAYS = [30, 60, 90] as const;
type AllowedRetroactiveDays = (typeof ALLOWED_RETROACTIVE_DAYS)[number];

function parseRetroactiveDays(value: unknown): AllowedRetroactiveDays {
  if (typeof value !== "number") {
    return 90;
  }

  if (ALLOWED_RETROACTIVE_DAYS.includes(value as AllowedRetroactiveDays)) {
    return value as AllowedRetroactiveDays;
  }

  return 90;
}

export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 5,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

      const days = parseRetroactiveDays(body.days);
      const maxRuns =
        typeof body.maxRuns === "number" ? Math.min(Math.max(1, body.maxRuns), 200) : 20;

      try {
        const job = await startWorkerSyncJob({
          estimatedScopeDays: days,
          requestedBy: session?.email ?? null,
          requestId,
          maxRuns,
        });

        return createApiSuccess(
          requestId,
          {
            jobId: job.id,
            status: job.status,
            mode: job.mode,
            estimatedScopeDays: job.estimatedScopeDays,
            startedAt: job.startedAt,
            maxRuns: job.maxRuns,
          },
          { phase: "worker_sync_start" }
        );
      } catch (error) {
        return createApiError(
          requestId,
          error instanceof Error ? error.message : "Falha ao iniciar job do worker.",
          500,
          { phase: "worker_sync_start" }
        );
      }
    }
  );
}
