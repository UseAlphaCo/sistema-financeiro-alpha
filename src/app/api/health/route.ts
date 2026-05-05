import { getPrismaClient } from "@/core/db/prisma-client";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export async function GET() {
  const requestId = crypto.randomUUID();

  try {
    const db = getPrismaClient();
    await db.$queryRaw`SELECT 1`;
  } catch {
    return createApiError(
      requestId,
      "Banco de dados indisponivel.",
      503,
      { service: "sistema-financeiro", version: "0.1.0", db: "down" }
    );
  }

  return createApiSuccess(requestId, {
    status: "ok",
    service: "sistema-financeiro",
    version: "0.1.0",
    db: "up",
  });
}
