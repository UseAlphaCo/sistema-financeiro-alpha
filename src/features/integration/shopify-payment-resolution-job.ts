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

export type ResolveOrderOptions = {
  /**
   * Se a Admin API nao devolver transacao resolvivel, APAGA o rateio que o
   * pedido ja tinha. Default `false` — apagar e a excecao, nao a regra.
   *
   * `replaceShopifyPaymentGatewaySplit(id, [])` limpa todas as pernas do
   * pedido: e contrato deliberado do repositorio, com teste proprio ("Lista
   * vazia limpa tudo"). O problema nunca foi esse contrato, e sim quem o
   * invoca sem ter motivo para apagar.
   *
   * Quem liga:  o job (findUnresolvedShopifyOrders alcanca pedido cujo
   *             `mirror_updated_at` mudou desde a resolucao — se o payload
   *             agora nao tem transacao, a perna velha precisa sair, senao
   *             soma em dobro na janela).
   * Quem NAO liga: a reconciliacao. Ela chega neste pedido justamente porque o
   *             tenderTransactions REPORTOU dinheiro nele. Uma resposta vazia
   *             do endpoint de transacoes contradiz a evidencia que trouxe o
   *             pedido ate aqui, e zerar o ledger com base na fonte que
   *             discorda troca um registro bom por um em branco — deixando o
   *             dado pior do que antes de tentar consertar. Preservando, a
   *             divergencia sobrevive e vira `sem_correcao`, que e' o estado
   *             correto: "re-resolvido e o ledger continua discordando".
   */
  clearSplitWhenEmpty?: boolean;
};

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
  externalOrderId: string,
  options: ResolveOrderOptions = {}
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

    // So apaga o rateio existente quem pediu explicitamente. Ver o docblock de
    // ResolveOrderOptions.clearSplitWhenEmpty para por que o default e' nao
    // apagar — e por que a reconciliacao depende disso.
    if (options.clearSplitWhenEmpty === true) {
      await replaceShopifyPaymentGatewaySplit(externalOrderId, []);
    }

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
        // Liga a limpeza porque o job alcanca tambem o pedido JA resolvido cujo
        // `mirror_updated_at` mudou. Se o payload agora nao tem transacao, a
        // perna velha precisa sair — senao ela soma em dobro na janela. Este e'
        // o unico caminho com motivo para apagar; a reconciliacao usa o default.
        const outcome = await resolveShopifyOrderById(
          storeDomain,
          accessToken,
          candidate.external_order_id,
          { clearSplitWhenEmpty: true }
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
