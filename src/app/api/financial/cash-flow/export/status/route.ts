import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import {
  getCashFlowExportJobById,
  getCurrentCashFlowExportJob,
} from "@/features/cash-flow/export-jobs";
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
    async ({ requestId, session }) => {
      const jobId = request.nextUrl.searchParams.get("jobId");
      const job = jobId
        ? await getCashFlowExportJobById(jobId)
        : await getCurrentCashFlowExportJob(session?.email ?? null);

      if (!job) {
        return createApiError(requestId, "Nenhum job de exportacao encontrado.", 404);
      }

      return createApiSuccess(requestId, {
        jobId: job.id,
        status: job.status,
        format: job.format,
        searchSummary: job.searchSummary,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        processedRows: job.processedRows,
        totalRows: job.totalRows,
        expiresAt: job.expiresAt,
        fileName: job.fileName,
        fileSizeBytes: job.fileSizeBytes,
        lastError: job.lastError,
        canDownload: job.status === "completed" && job.hasFile,
      });
    }
  );
}
