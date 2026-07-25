import type { NextRequest } from "next/server";

import { runShopifyPaymentResolutionJob } from "@/features/integration/shopify-payment-resolution-job";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export const runtime = "nodejs";

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 500;

function parseBatchSize(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.floor(parsed), MAX_BATCH_SIZE);
}

// Escopa a rodada a pedidos recebidos nos ultimos N dias — permite priorizar
// o periodo recente (o que o Fluxo de Caixa mostra) sem depender de esvaziar
// o backlog historico inteiro numa unica chamada.
function parseSinceDays(value: string | null): Date | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const since = new Date();
  since.setDate(since.getDate() - parsed);
  return since;
}

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const bearer = request.headers.get("authorization");
  if (bearer === `Bearer ${expected}`) return true;

  const direct = request.headers.get("x-cron-secret");
  return direct === expected;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!isAuthorized(request)) {
    return createApiError(requestId, "Nao autorizado.", 401);
  }

  const batchSize = parseBatchSize(request.nextUrl.searchParams.get("batchSize"));
  const sinceReceivedAt = parseSinceDays(request.nextUrl.searchParams.get("sinceDays"));

  try {
    const summary = await runShopifyPaymentResolutionJob(batchSize, sinceReceivedAt);
    return createApiSuccess(requestId, summary);
  } catch (error) {
    return createApiError(
      requestId,
      error instanceof Error ? error.message : "Falha ao resolver gateway titular dos pedidos Shopify.",
      500
    );
  }
}
