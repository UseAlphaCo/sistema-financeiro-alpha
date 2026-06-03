import type { NextRequest } from "next/server";

import { logError, logInfo } from "@/core/observability/logger";
import { verifyShopifyHmac } from "@/core/security/verify-shopify-hmac";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";
import { handleShopifyWebhook } from "@/features/integration/shopify-webhook-handler";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  const rawBody = await request.text();

  const hmacHeader = request.headers.get("x-shopify-hmac-sha256") ?? "";
  const eventId = request.headers.get("x-shopify-webhook-id") ?? "";
  const topic = request.headers.get("x-shopify-topic") ?? "";
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET ?? "";
  const safeSecret = secret.replace(/^['"]+|['"]+$/g, "").replace(/\r?\n/g, "").trim();

  if (!safeSecret) {
    logError("shopify_webhook_secret_missing", { requestId, topic });
    return createApiError(requestId, "SHOPIFY_WEBHOOK_SECRET nao configurado", 503);
  }

  // Mirror-first mode: disable direct webhooks if configured to avoid dual-writes.
  if (process.env.DISABLE_SHOPIFY_WEBHOOKS === "true" || process.env.FINANCIAL_READ_MODEL_MIRROR === "true") {
    logInfo("shopify_webhook_disabled", { requestId, topic });
    return createApiError(
      requestId,
      "Webhook temporariamente desativado: envie eventos via Worker/mirror-first",
      410
    );
  }

  if (!verifyShopifyHmac(rawBody, hmacHeader, safeSecret)) {
    logInfo("shopify_webhook_hmac_invalid", {
      requestId,
      topic,
      hasHmacHeader: Boolean(hmacHeader),
      hmacLength: hmacHeader.length,
      secretLength: safeSecret.length,
    });
    return createApiError(requestId, "Assinatura HMAC inválida", 401);
  }

  if (!eventId) {
    return createApiError(requestId, "Header x-shopify-webhook-id ausente", 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return createApiError(requestId, "Corpo da requisição não é JSON válido", 400);
  }

  logInfo("shopify_webhook_received", { requestId, eventId, topic });

  const result = await handleShopifyWebhook(eventId, topic, payload);

  if (!result.success) {
    logError("shopify_webhook_processing_failed", {
      requestId,
      eventId,
      topic,
      error: result.error,
    });
    return createApiSuccess(requestId, { status: "failed" }, { eventId, topic });
  }

  logInfo("shopify_webhook_processed", {
    requestId,
    eventId,
    topic,
    status: result.data.status,
  });

  return createApiSuccess(requestId, { status: result.data.status }, { eventId, topic });
}
