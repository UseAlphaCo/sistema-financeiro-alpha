import { NextRequest, NextResponse } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { getCashFlowExportFile, getCashFlowExportJobById } from "@/features/cash-flow/export-jobs";
import { createApiError } from "@/shared/api/envelope";

export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    {
      requireAuth: true,
      allowedRoles: ["admin", "financeiro"],
      rateLimit: 30,
      sensitive: true,
    },
    async ({ requestId, session }) => {
      const jobId = request.nextUrl.searchParams.get("jobId");
      if (!jobId) {
        return createApiError(requestId, "Parametro jobId e obrigatorio.", 400);
      }

      const job = await getCashFlowExportJobById(jobId);
      if (!job) {
        return createApiError(requestId, "Job de exportacao nao encontrado.", 404);
      }

      const requesterEmail = session?.email ?? null;
      const isAdmin = session?.role === "admin";
      if (!isAdmin && requesterEmail && job.requestedBy && requesterEmail !== job.requestedBy) {
        return createApiError(requestId, "Sem permissao para baixar este arquivo.", 403);
      }

      const file = await getCashFlowExportFile(jobId);
      if (!file) {
        return createApiError(requestId, "Arquivo ainda nao esta pronto para download.", 409);
      }

      if (file.expiresAt && new Date(file.expiresAt).getTime() < Date.now()) {
        return createApiError(requestId, "Arquivo de exportacao expirado.", 410);
      }

      return new NextResponse(new Uint8Array(file.data), {
        status: 200,
        headers: {
          "Content-Type": file.mimeType,
          "Content-Disposition": `attachment; filename="${file.fileName}"`,
          "Cache-Control": "no-store",
          "x-request-id": requestId,
        },
      });
    }
  );
}
