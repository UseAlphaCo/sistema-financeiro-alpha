import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import {
  getCurrentWorkerSyncJob,
  getWorkerSyncJob,
} from "@/features/integration/worker-sync-jobs";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

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
      const jobId = request.nextUrl.searchParams.get("jobId");
      const job = jobId ? await getWorkerSyncJob(jobId) : await getCurrentWorkerSyncJob();

      if (!job) {
        return createApiError(requestId, "Nenhum job de sincronizacao encontrado.", 404);
      }

      return createApiSuccess(requestId, {
        jobId: job.id,
        status: job.status,
        mode: job.mode,
        estimatedScopeDays: job.estimatedScopeDays,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        requestedBy: job.requestedBy,
        maxRuns: job.maxRuns,
        runs: job.runs,
        lastError: job.lastError,
        summary: job.summary,
      });
    }
  );
}
