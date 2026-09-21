/**
 * Reconciliacao recorrente: encontra e conserta o pedido cujo ledger de rateio
 * discorda do que a Shopify diz ter recebido.
 *
 * ─── A classe de pedido que so esta rotina alcanca ──────────────────────────
 *
 * O job de resolucao descobre candidatos por
 * `spr.external_order_id IS NULL OR rp.mirror_updated_at > spr.resolved_at`. Uma
 * captura que a Shopify registra dois dias depois do pedido **nao altera o
 * payload do mirror**, entao `mirror_updated_at` nao muda e o job nunca
 * reencontra o pedido. O auto-alinhamento do shopify-verify chama esse mesmo
 * job, logo tambem e' no-op por construcao para esses casos. O backfill so
 * alcanca pedido que ainda nao tem NENHUMA linha de rateio; nao alcanca "rateio
 * com valor velho".
 *
 * Em 30/08/2026 isso foram R$ 94,97 de uma perna Appmax atrasada, que so
 * entraram no ledger por uma lista de ids montada a mao.
 *
 * A saida e comparar contra uma fonte externa por pedido — o tenderTransactions
 * — e re-resolver quem divergir. E' a unica capacidade genuinamente nova que a
 * paridade ainda pedia.
 *
 * ─── Por que o ciclo fecha sem codigo novo no caminho de leitura ────────────
 *
 * `upsertShopifyPaymentResolution` grava `resolved_at = NOW()`;
 * `findOrderKeysWithStaleResolution` seleciona por `resolved_at >
 * materialized_at`; o passo 1b da materializacao ja consome esse conjunto. O
 * pedido reconciliado reentra na materializacao sozinho.
 *
 * Consequencia de ORDEM, que vale dizer em voz alta: esta rotina roda as 10:50,
 * depois da materializacao das 10:40. A correcao aparece na tela no passe
 * seguinte, nao na hora.
 */

import { logError, logInfo } from "@/core/observability/logger";
import { addDaysToDayKey, dayWindowUtc } from "@/lib/date-utils";

import { normalizeShopifyStoreDomain, stripWrappingQuotes } from "./shopify-orders-sync";
import { resolveShopifyOrderById } from "./shopify-payment-resolution-job";
import { findLedgerGatewayTotalsByOrderIds } from "./shopify-payment-resolution-repository";
import {
  countDivergencesByStatus,
  ensureShopifyReconciliationTable,
  markDivergenceOutcome,
  recordDetectedDivergences,
  type ReconciliationStatus,
} from "./shopify-reconciliation-repository";
import {
  fetchTenderTransactions,
  tenderOrderIdsInWindow,
  tenderTotalsByOrder,
  widenedWindowForRange,
} from "./shopify-tender-transactions";
import {
  detectOrderDivergences,
  formatMoney,
  VERIFICATION_TIMEZONE,
  type OrderDivergence,
} from "./shopify-value-verification";

/**
 * Quantos dias fechados a rodada varre, a partir de D-1.
 *
 * Tres, e nao um: a captura atrasada que motiva esta rotina foi observada
 * chegando ate ~2 dias depois (30/08/2026, capturas Appmax que a Shopify so
 * registrou em 01-02/09). Olhar so D-1 nunca enxergaria a classe que a
 * reconciliacao existe para fechar.
 */
const RECONCILE_DAYS = 3;

/**
 * Teto de correcoes por rodada.
 *
 * Cada correcao e' uma chamada REST a Admin API, serializada pelo portao de
 * 500 ms do bucket: 60 correcoes = ~30 s. A verificacao que roda antes consome
 * ~42 s dos 300 s de `maxDuration` da rota, entao o teto cabe com folga larga.
 * O excedente fica `pendente` e entra na rodada seguinte — como a lista vem
 * ordenada por |delta| decrescente, o que fica para depois e' sempre o menor
 * dinheiro.
 *
 * Em regime normal sao ~3 pedidos/dia; o teto existe para o dia anormal nao
 * derrubar a rota inteira por timeout.
 */
const MAX_FIXES = 60;

/** Tolerancia em centavos para considerar que o ledger passou a bater. */
const TOLERANCE_CENTS = 1;

export type ReconciliationSummary = {
  /** Dias efetivamente varridos (D-1 pode ficar de fora se estiver imaturo). */
  days: string[];
  /** D-1 foi pulado porque a fila do dia ainda nao drenou. */
  skippedImmatureDay: string | null;
  comparedOrders: number;
  detected: number;
  corrected: number;
  stillDiverging: number;
  failed: number;
  /** Divergencias que o teto da rodada deixou para a proxima. */
  deferred: number;
  /** A rodada so olhou: nao gravou nem corrigiu nada. */
  dryRun: boolean;
  /** Os pedidos divergentes. So preenchido em dryRun, para inspecao. */
  sample?: OrderDivergence[];
  driftCents: number;
  driftFormatted: string;
  /** Contagem acumulada por status, para o painel. */
  byStatus: Record<ReconciliationStatus, number>;
};

export type ReconciliationOptions = {
  /** Ultimo dia da janela. Por omissao, D-1 no fuso da verificacao. */
  endDate?: string;
  /** Quantos dias varrer para tras. Por omissao, RECONCILE_DAYS. */
  days?: number;
  /**
   * D-1 esta maduro (fila drenada)?
   *
   * Vem de fora, e nao e' recalculado aqui, porque quem chama (a rota de
   * verificacao) acabou de calcular MaturitySignal para o mesmo dia — recalcular
   * criaria uma segunda definicao de maturidade que pode discordar da que gerou,
   * ou nao, o alerta.
   *
   * Por que importa: em 09/09/2026 um dia imaturo mostrou 60 pedidos divergentes
   * as 08:46 e 3 as 09:31, **sem ninguem corrigir nada**. Os 57 nunca divergiram
   * — so ainda nao tinham perna no ledger. Reconciliar dia imaturo dispararia
   * dezenas de re-resolucoes contra uma fila que ia drenar sozinha.
   */
  latestDayIsMature?: boolean;
  /** Teto de correcoes. Por omissao, MAX_FIXES. */
  maxFixes?: number;
  /**
   * So detecta: nao grava a divergencia nem re-resolve nada.
   *
   * Existe porque esta rotina escreve no ledger de producao, e a primeira
   * pergunta de quem opera e' "o que voce faria?" antes de "faca". Nao e' usada
   * pelo cron — e para inspecao a mao, via CLI.
   */
  dryRun?: boolean;
};

export async function runShopifyReconciliation(
  options: ReconciliationOptions = {}
): Promise<ReconciliationSummary> {
  await ensureShopifyReconciliationTable();

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");
  if (!storeDomain) throw new Error("SHOPIFY_STORE_URL ausente ou invalido.");
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN ausente.");

  const endDate = options.endDate ?? addDaysToDayKey(hojeNoFuso(VERIFICATION_TIMEZONE), -1);
  const totalDays = options.days ?? RECONCILE_DAYS;
  const maxFixes = options.maxFixes ?? MAX_FIXES;

  // D-1 so entra se a fila do dia drenou. D-2 e D-3 entram sempre: ja passaram
  // por varios passes de materializacao e de resolucao.
  const immature = options.latestDayIsMature === false;
  const days = janelaDeDias(endDate, totalDays).filter((day) => !(immature && day === endDate));

  const vazio: ReconciliationSummary = {
    days,
    skippedImmatureDay: immature ? endDate : null,
    comparedOrders: 0,
    detected: 0,
    corrected: 0,
    stillDiverging: 0,
    failed: 0,
    deferred: 0,
    driftCents: 0,
    driftFormatted: formatMoney(0),
    byStatus: await countDivergencesByStatus(),
    dryRun: options.dryRun === true,
  };

  if (days.length === 0) return vazio;

  // Uma unica busca paginada cobre o intervalo inteiro com a folga de um dia
  // para cada lado — nao uma busca por dia.
  const widened = widenedWindowForRange(days[0], days[days.length - 1], VERIFICATION_TIMEZONE);
  const tenders = await fetchTenderTransactions(storeDomain, accessToken, widened.from, widened.to);

  // O dia de cada pedido sai da MESMA regra de candidato da verificacao diaria
  // (tenderOrderIdsInWindow), dia a dia, para que a linha gravada diga em que
  // janela a divergencia apareceu.
  const diaPorPedido = new Map<string, string>();
  for (const day of days) {
    const window = dayWindowUtc(day, VERIFICATION_TIMEZONE);
    for (const orderId of tenderOrderIdsInWindow(tenders, window.start, window.end)) {
      diaPorPedido.set(orderId, day);
    }
  }

  const candidatos = new Set(diaPorPedido.keys());
  const { byOrder: tenderPorPedido } = tenderTotalsByOrder(tenders, candidatos);
  const ledgerPorPedido = await findLedgerGatewayTotalsByOrderIds([...candidatos]);
  const divergences = detectOrderDivergences(tenderPorPedido, ledgerPorPedido, TOLERANCE_CENTS);

  const driftCents = divergences.reduce((soma, item) => soma + Math.abs(item.deltaCents), 0);

  if (!options.dryRun) {
    await recordDetectedDivergences(
      divergences.map((item) => ({
        externalOrderId: item.orderId,
        day: diaPorPedido.get(item.orderId) ?? endDate,
        tenderCents: item.tenderCents,
        ledgerCents: item.ledgerCents,
        deltaCents: item.deltaCents,
      }))
    );
  }

  const aCorrigir = options.dryRun ? [] : divergences.slice(0, maxFixes);
  const { corrected, stillDiverging, failed } = await corrigir(
    storeDomain,
    accessToken,
    aCorrigir,
    tenderPorPedido
  );

  const summary: ReconciliationSummary = {
    days,
    skippedImmatureDay: immature ? endDate : null,
    comparedOrders: tenderPorPedido.size,
    detected: divergences.length,
    corrected,
    stillDiverging,
    failed,
    deferred: options.dryRun ? 0 : Math.max(0, divergences.length - aCorrigir.length),
    driftCents,
    driftFormatted: formatMoney(driftCents),
    byStatus: await countDivergencesByStatus(),
    dryRun: options.dryRun === true,
    ...(options.dryRun ? { sample: divergences } : {}),
  };

  logInfo("shopify_reconciliation_complete", summary);
  return summary;
}

/**
 * Re-resolve cada pedido e confere se o ledger passou a bater.
 *
 * Serial de proposito, ao contrario do job de resolucao que usa concorrencia 5:
 * o conjunto aqui e' pequeno (~3/dia em regime normal) e o custo de uma rajada
 * concorrente contra a Admin API nao se paga. O teto de MAX_FIXES ja garante o
 * tempo de parede.
 */
async function corrigir(
  storeDomain: string,
  accessToken: string,
  divergences: OrderDivergence[],
  tenderPorPedido: ReadonlyMap<string, number>
): Promise<{ corrected: number; stillDiverging: number; failed: number }> {
  let corrected = 0;
  let stillDiverging = 0;
  let failed = 0;

  for (const divergence of divergences) {
    try {
      // Sem `clearSplitWhenEmpty`: o default preserva o rateio quando a Admin
      // API nao devolve transacao. Chegamos neste pedido porque o
      // tenderTransactions REPORTOU dinheiro nele — uma resposta vazia do
      // endpoint de transacoes contradiz essa evidencia, e apagar o ledger com
      // base nela deixaria o dado pior do que antes do conserto. Preservando, a
      // divergencia sobrevive a medicao abaixo e vira `sem_correcao`.
      await resolveShopifyOrderById(storeDomain, accessToken, divergence.orderId);

      // Rele o ledger do pedido e aplica a MESMA regra de comparacao da
      // deteccao: confirmar o conserto por qualquer outro criterio abriria
      // espaco para marcar como corrigido um pedido que continua errado.
      //
      // Tolerancia -1 de proposito: o predicado de descarte e `|delta| <=
      // tolerancia`, entao um valor negativo nunca descarta e a medicao volta
      // SEMPRE, inclusive quando fecha em zero. E' o que permite gravar o
      // ledger comparavel de verdade em vez de presumir que ele virou igual ao
      // tender — nao vira, porque o pedido pode ter pernas de credito na loja,
      // que o comparavel exclui dos dois lados. O veredito de "ainda diverge"
      // fica explicito na linha seguinte, com a tolerancia real.
      const depois = await findLedgerGatewayTotalsByOrderIds([divergence.orderId]);
      const [medida] = detectOrderDivergences(
        new Map([[divergence.orderId, tenderPorPedido.get(divergence.orderId) ?? 0]]),
        depois,
        -1
      );
      const aindaDiverge = Math.abs(medida?.deltaCents ?? 0) > TOLERANCE_CENTS;

      const status: ReconciliationStatus = aindaDiverge ? "sem_correcao" : "corrigido";
      await markDivergenceOutcome(divergence.orderId, status, medida?.ledgerCents ?? 0);

      if (aindaDiverge) stillDiverging += 1;
      else corrected += 1;
    } catch (error) {
      // A linha fica `pendente` (recordDetectedDivergences ja gravou) e volta na
      // proxima rodada. Um pedido que falha nao pode derrubar os outros.
      failed += 1;
      logError("shopify_reconciliation_order_failed", {
        externalOrderId: divergence.orderId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { corrected, stillDiverging, failed };
}

/** Os `total` dias terminando em `endDate`, do mais antigo para o mais novo. */
function janelaDeDias(endDate: string, total: number): string[] {
  const days: string[] = [];
  for (let offset = total - 1; offset >= 0; offset -= 1) {
    days.push(addDaysToDayKey(endDate, -offset));
  }
  return days;
}

function hojeNoFuso(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
