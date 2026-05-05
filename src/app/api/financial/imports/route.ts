import { NextRequest } from "next/server";

import { withApiSecurity } from "@/core/security/with-api-security";
import { commitImportAction, listImportBatchesAction, previewImportAction, rollbackImportAction } from "@/features/imports/actions";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

// GET /api/financial/imports — lista lotes de importação
export async function GET(request: NextRequest) {
  return withApiSecurity(
    request,
    { requireAuth: true, allowedRoles: ["admin", "financeiro"], rateLimit: 30, sensitive: true },
    async ({ requestId }) => {
      const result = await listImportBatchesAction();
      if (!result.success) return createApiError(requestId, result.error, 500);
      return createApiSuccess(requestId, { items: result.data });
    }
  );
}

// POST /api/financial/imports — upload CSV (preview) ou confirmar/reverter lote
export async function POST(request: NextRequest) {
  return withApiSecurity(
    request,
    { requireAuth: true, allowedRoles: ["admin", "financeiro"], rateLimit: 10, sensitive: true },
    async ({ requestId, session }) => {
      const contentType = request.headers.get("content-type") ?? "";

      // Ação sobre lote existente: { action: "commit"|"rollback", batchId }
      if (contentType.includes("application/json")) {
        const body = (await request.json()) as { action?: string; batchId?: string };

        if (body.action === "commit") {
          if (!body.batchId) return createApiError(requestId, "batchId obrigatório.", 400);
          const result = await commitImportAction({ batchId: body.batchId, userId: session!.id });
          if (!result.success) return createApiError(requestId, result.error, 422);
          return createApiSuccess(requestId, result.data);
        }

        if (body.action === "rollback") {
          if (!body.batchId) return createApiError(requestId, "batchId obrigatório.", 400);
          const result = await rollbackImportAction({ batchId: body.batchId });
          if (!result.success) return createApiError(requestId, result.error, 422);
          return createApiSuccess(requestId, result.data);
        }

        return createApiError(requestId, "Ação inválida. Use 'commit' ou 'rollback'.", 400);
      }

      // Upload de arquivo CSV via multipart/form-data
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const file = formData.get("file");
        const source = (formData.get("source") as string | null) ?? "manual";

        if (!file || typeof file === "string") {
          return createApiError(requestId, "Campo 'file' ausente ou inválido.", 400);
        }

        const csvContent = await (file as File).text();
        const result = await previewImportAction({ csvContent, source });
        if (!result.success) return createApiError(requestId, result.error, 422);
        return createApiSuccess(requestId, result.data, undefined, 201);
      }

      return createApiError(requestId, "Content-Type não suportado. Use multipart/form-data ou application/json.", 415);
    }
  );
}

