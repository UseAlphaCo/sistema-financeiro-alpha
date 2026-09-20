import { logError, logInfo } from "@/core/observability/logger";

import {
  normalizeShopifyStoreDomain,
  stripWrappingQuotes,
} from "./shopify-orders-sync";
import {
  ensureShopifyPaymentGatewaySplitTable,
  ensureShopifyPaymentResolutionTable,
  findUnresolvedShopifyOrders,
  replaceShopifyPaymentGatewaySplit,
  upsertShopifyPaymentResolution,
} from "./shopify-payment-resolution-repository";
import {
  fetchShopifyOrderTransactions,
  resolveDominantPaymentMethod,
  resolvePaymentGatewaySplit,
} from "./shopify-order-transactions";

export type ShopifyPaymentResolutionJobResult = {
  candidates: number;
  resolved: number;
  skipped: number;
  failed: number;
};

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_CONCURRENCY = 5;

/** O que aconteceu com um pedido ao ser resolvido. */
export type OrderResolutionOutcome = "resolvido" | "sem_transacao";

/**
 * Resolve UM pedido: busca as transacoes na Shopify, grava o gateway titular e
 * substitui o rateio por gateway.
 *
 * Extraida do laco do job para poder ser chamada por id. O job continua sendo o
 * caminho normal (ele DESCOBRE quem precisa), mas existe uma classe de pedido que
 * ele nao alcanca por construcao: o pedido ja resolvido que recebeu transacao
 * nova. O predicado de findUnresolvedShopifyOrders depende de
 * `rp.mirror_updated_at`, e uma captura registrada dias depois na Shopify nao
 * toca o payload do mirror. Quem descobre esses e a reconciliacao, comparando
 * contra o tenderTransactions — e entao precisa de uma porta de entrada por id.
 *
 * Sem tratamento de erro de proposito: quem chama decide se conta como falha de
 * um pedido (o job) ou se registra a divergencia como nao corrigida (a
 * reconciliacao).
 */
export async function resolveShopifyOrderById(
  storeDomain: string,
  accessToken: string,
  externalOrderId: string
): Promise<OrderResolutionOutcome> {
  const transactions = await fetchShopifyOrderTransactions(storeDomain, accessToken, externalOrderId);
  const dominant = resolveDominantPaymentMethod(transactions);

  if (!dominant) {
    // Registra a tentativa mesmo sem transacao resolvivel — sem isso, o pedido
    // nunca sai de findUnresolvedShopifyOrders (spr.external_order_id IS NULL
    // continua verdadeiro) e e reprocessado a cada rodada, para sempre, sem
    // nunca convergir para candidates=0.
    await upsertShopifyPaymentResolution({
      external_order_id: externalOrderId,
      dominant_gateway_raw: null,
      dominant_amount_cents: 0,
      total_amount_cents: 0,
      transaction_processed_at: null,
    });
    await replaceShopifyPaymentGatewaySplit(externalOrderId, []);
    return "sem_transacao";
  }

  await upsertShopifyPaymentResolution({
    external_order_id: externalOrderId,
    dominant_gateway_raw: dominant.gatewayRaw,
    dominant_amount_cents: dominant.dominantAmountCents,
    total_amount_cents: dominant.totalAmountCents,
    transaction_processed_at: dominant.processedAt,
  });

  // Persiste o rateio de TODO pedido resolvido, inclusive os de um gateway so. A
  // versao anterior gravava so quando havia >=2 gateways, o que bastava para
  // corrigir a quebra por forma de pagamento; mas o Fluxo de Caixa passou a datar
  // cada perna do pagamento pelo seu proprio processed_at (que e como a Shopify
  // monta o relatorio), e isso exige que a tabela cubra o dia inteiro, nao so os
  // splits. Custo: ~1.150 linhas/dia em vez de ~13.
  await replaceShopifyPaymentGatewaySplit(externalOrderId, resolvePaymentGatewaySplit(transactions));
  return "resolvido";
}

/**
 * Resolve o gateway titular (maior valor R$ pago no pedido) para pedidos
 * Shopify pagos que ainda nao foram processados, ou cujo mirror mudou desde a
 * ultima resolucao. Roda de forma incremental e idempotente — pode ser
 * chamado repetidamente sem duplicar trabalho.
 */
export async function runShopifyPaymentResolutionJob(
  batchSize = DEFAULT_BATCH_SIZE,
  sinceReceivedAt?: Date
): Promise<ShopifyPaymentResolutionJobResult> {
  await ensureShopifyPaymentResolutionTable();
  await ensureShopifyPaymentGatewaySplitTable();

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");

  if (!storeDomain || !accessToken) {
    throw new Error("SHOPIFY_STORE_URL/SHOPIFY_ACCESS_TOKEN nao configurados para o job de resolucao de gateway.");
  }

  const candidates = await findUnresolvedShopifyOrders(batchSize, sinceReceivedAt);

  let resolved = 0;
  let skipped = 0;
  let failed = 0;
  let index = 0;

  async function worker() {
    while (index < candidates.length) {
      const candidate = candidates[index++];

      try {
        const outcome = await resolveShopifyOrderById(
          storeDomain,
          accessToken,
          candidate.external_order_id
        );

        if (outcome === "sem_transacao") skipped += 1;
        else resolved += 1;
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
