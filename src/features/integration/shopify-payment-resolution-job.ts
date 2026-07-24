import { logError, logInfo } from "@/core/observability/logger";

import {
  normalizeShopifyStoreDomain,
  stripWrappingQuotes,
} from "./shopify-orders-sync";
import {
  ensureShopifyPaymentResolutionTable,
  findUnresolvedShopifyOrders,
  upsertShopifyPaymentResolution,
} from "./shopify-payment-resolution-repository";
import {
  fetchShopifyOrderTransactions,
  resolveDominantPaymentMethod,
} from "./shopify-order-transactions";

export type ShopifyPaymentResolutionJobResult = {
  candidates: number;
  resolved: number;
  skipped: number;
  failed: number;
};

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_CONCURRENCY = 5;

/**
 * Resolve o gateway titular (maior valor R$ pago no pedido) para pedidos
 * Shopify pagos que ainda nao foram processados, ou cujo mirror mudou desde a
 * ultima resolucao. Roda de forma incremental e idempotente — pode ser
 * chamado repetidamente sem duplicar trabalho.
 */
export async function runShopifyPaymentResolutionJob(
  batchSize = DEFAULT_BATCH_SIZE
): Promise<ShopifyPaymentResolutionJobResult> {
  await ensureShopifyPaymentResolutionTable();

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");

  if (!storeDomain || !accessToken) {
    throw new Error("SHOPIFY_STORE_URL/SHOPIFY_ACCESS_TOKEN nao configurados para o job de resolucao de gateway.");
  }

  const candidates = await findUnresolvedShopifyOrders(batchSize);

  let resolved = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;

  async function worker() {
    while (index < candidates.length) {
      const candidate = candidates[index++];

      try {
        const transactions = await fetchShopifyOrderTransactions(
          storeDomain,
          accessToken,
          candidate.external_order_id
        );
        const dominant = resolveDominantPaymentMethod(transactions);

        if (!dominant) {
          skipped += 1;
          continue;
        }

        await upsertShopifyPaymentResolution({
          external_order_id: candidate.external_order_id,
          dominant_gateway_raw: dominant.gatewayRaw,
          dominant_amount_cents: dominant.dominantAmountCents,
          total_amount_cents: dominant.totalAmountCents,
          transaction_processed_at: dominant.processedAt,
        });
        resolved += 1;
      } catch (error) {
        failed += 1;
        logError("shopify_payment_resolution_order_failed", {
          externalOrderId: candidate.external_order_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(DEFAULT_CONCURRENCY, candidates.length) }, () => worker())
  );

  const summary: ShopifyPaymentResolutionJobResult = {
    candidates: candidates.length,
    resolved,
    skipped,
    failed,
  };

  logInfo("shopify_payment_resolution_job_complete", summary);

  return summary;
}
