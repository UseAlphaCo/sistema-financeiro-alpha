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
  listRetryableDivergences,
  markDivergenceAttemptFailed,
  markDivergenceOutcome,
  recordDetectedDivergences,
  type ReconciliationDivergenceRow,
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

/**
 * Espera, em dias, depois da 1a, 2a, 3a e 4a tentativa frustrada.
 *
 * Dias, e nao minutos, porque a rodada e' diaria (10:50 BRT): qualquer recuo
 * menor que 24 h e' indistinguivel de "tenta de novo amanha" e so daria falsa
 * sensacao de escalonamento. Dobrando, um pedido sem conserto e' tentado em
 * D+0, D+1, D+3, D+7 e D+15 — cerca de duas semanas de paciencia antes de o
 * sistema admitir que sozinho nao resolve.
 *
 * O recuo nao existe para "dar tempo de a Shopify se recuperar": existe para o
 * pedido irrecuperavel parar de consumir uma vaga do teto e uma chamada a Admin
 * API em toda rodada, o que empurraria para tras o dinheiro que ainda tem
 * conserto.
 */
const RETRY_BACKOFF_DAYS = [1, 2, 4, 8] as const;

/**
 * Tentativas antes de a linha virar problema de gente.
 *
 * Derivado, nao escrito a mao: sao as esperas acima mais a tentativa que as
 * inaugura. Manter os dois numeros independentes criaria o bug silencioso de um
 * pedido que esgota o orcamento sem nunca ter esperado o ultimo intervalo.
 */
export const MAX_RETRY_ATTEMPTS = RETRY_BACKOFF_DAYS.length + 1;

/**
 * Quando a linha volta a ser elegivel, dado quantas tentativas ja foram gastas.
 *
 * `null` significa orcamento esgotado: nao ha proxima. Quem chama traduz isso
 * em `sem_correcao`, que e' o unico status que o painel pinta de vermelho por
 * significar "nenhum mecanismo alcanca isto".
 */
export function nextAttemptAfter(attemptsFeitas: number, now: Date): Date | null {
  if (attemptsFeitas < 1) throw new Error("attemptsFeitas deve contar a tentativa atual.");
  const dias = RETRY_BACKOFF_DAYS[attemptsFeitas - 1];
  if (dias === undefined) return null;
  return new Date(now.getTime() + dias * 24 * 60 * 60 * 1000);
}

/**
 * O que gravar depois de uma tentativa que produziu medicao.
 *
 * A regra que muda de comportamento em relacao ao que existia antes: divergir
 * ainda **nao** e' mais sinonimo de `sem_correcao`. Enquanto houver tentativa no
 * orcamento a linha segue `pendente`, porque um mecanismo ainda vai busca-la — e
 * o painel reserva o vermelho para o que nenhum mecanismo alcanca. Marcar
 * `sem_correcao` na primeira falha chamaria de emergencia uma fila que esta
 * andando, e e' assim que um alerta vira ruido que ninguem le.
 *
 * `persistente` sobrevive a retentativa de proposito: "ja fechou e reabriu" e'
 * um sinal sobre a CAUSA, nao sobre a fila, e rebaixa-lo a `pendente` apagaria a
 * unica pista de defeito estrutural que a tabela guarda.
 */
export function decideRetryOutcome(args: {
  aindaDiverge: boolean;
  attemptsFeitas: number;
  statusAnterior: ReconciliationStatus;
  now: Date;
}): { status: ReconciliationStatus; nextAttemptAt: Date | null } {
  if (!args.aindaDiverge) return { status: "corrigido", nextAttemptAt: null };

  const nextAttemptAt = nextAttemptAfter(args.attemptsFeitas, args.now);
  if (nextAttemptAt === null) return { status: "sem_correcao", nextAttemptAt: null };

  const status: ReconciliationStatus =
    args.statusAnterior === "persistente" ? "persistente" : "pendente";
  return { status, nextAttemptAt };
}

export type ReconciliationSummary = {
  /** Dias efetivamente varridos (D-1 pode ficar de fora se estiver imaturo). */
  days: string[];
  /** D-1 foi pulado porque a fila do dia ainda nao drenou. */
  skippedImmatureDay: string | null;
  comparedOrders: number;
  /** Divergentes encontrados NA JANELA desta rodada. */
  detected: number;
  /**
   * Linhas elegiveis na fila, antes do teto.
   *
   * Pode ser maior que `detected`: a fila herda o que rodadas anteriores nao
   * conseguiram fechar e que ja saiu da janela D-1..D-3. Era exatamente esse
   * conjunto que nao tinha quem olhasse.
   */
  queued: number;
  corrected: number;
  stillDiverging: number;
  failed: number;
  /** Esgotaram o orcamento de tentativas nesta rodada: agora esperam gente. */
  exhausted: number;
  /** Elegiveis que o teto da rodada deixou para a proxima. */
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

  // Passo 1 — o que a janela mostra hoje. Nao corrige nada: so mede e registra.
  const janela = await varrerJanela(storeDomain, accessToken, days);

  if (!options.dryRun) {
    await recordDetectedDivergences(
      janela.divergences.map((item) => ({
        externalOrderId: item.orderId,
        day: janela.diaPorPedido.get(item.orderId) ?? endDate,
        tenderCents: item.tenderCents,
        ledgerCents: item.ledgerCents,
        deltaCents: item.deltaCents,
      }))
    );
  }

  // Passo 2 — a fila. Ler da tabela em vez de corrigir direto a lista do passo 1
  // e' o que torna a rotina auto-regulavel: o que acabou de ser detectado e o que
  // sobrou de rodadas passadas entram pelo MESMO caminho, disputam o MESMO teto e
  // saem ordenados pelo MESMO criterio (maior dinheiro primeiro). Antes, quem
  // saisse da janela D-1..D-3 sem conserto nao tinha segunda chance.
  const fila = options.dryRun
    ? { rows: [], eligible: 0 }
    : await listRetryableDivergences({ limit: maxFixes, maxAttempts: MAX_RETRY_ATTEMPTS });

  // Passo 3 — trabalhar a fila dentro do orcamento da rodada.
  const resultado = await corrigir(storeDomain, accessToken, fila.rows, janela.tenderPorPedido);

  const summary: ReconciliationSummary = {
    days,
    skippedImmatureDay: immature ? endDate : null,
    comparedOrders: janela.tenderPorPedido.size,
    detected: janela.divergences.length,
    queued: fila.eligible,
    corrected: resultado.corrected,
    stillDiverging: resultado.stillDiverging,
    failed: resultado.failed,
    exhausted: resultado.exhausted,
    deferred: Math.max(0, fila.eligible - fila.rows.length),
    driftCents: janela.driftCents,
    driftFormatted: formatMoney(janela.driftCents),
    byStatus: await countDivergencesByStatus(),
    dryRun: options.dryRun === true,
    ...(options.dryRun ? { sample: janela.divergences } : {}),
  };

  logInfo("shopify_reconciliation_complete", summary);
  return summary;
}

type VarreduraDaJanela = {
  divergences: OrderDivergence[];
  tenderPorPedido: ReadonlyMap<string, number>;
  diaPorPedido: ReadonlyMap<string, string>;
  driftCents: number;
};

/**
 * Compara a janela contra a Shopify. So mede.
 *
 * Devolve vazio quando nao ha dia a varrer (D-1 imaturo com `days: 1`) em vez de
 * abortar a rodada: a fila herdada de rodadas anteriores independe da janela, e
 * era justamente para nao depender dela que a fila existe. Cada linha da fila
 * carrega o proprio `tender_cents`, entao o passo seguinte trabalha sem esta
 * medicao.
 */
async function varrerJanela(
  storeDomain: string,
  accessToken: string,
  days: string[]
): Promise<VarreduraDaJanela> {
  if (days.length === 0) {
    return {
      divergences: [],
      tenderPorPedido: new Map(),
      diaPorPedido: new Map(),
      driftCents: 0,
    };
  }

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

  return {
    divergences,
    tenderPorPedido,
    diaPorPedido,
    driftCents: divergences.reduce((soma, item) => soma + Math.abs(item.deltaCents), 0),
  };
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
  fila: ReconciliationDivergenceRow[],
  tenderPorPedido: ReadonlyMap<string, number>
): Promise<{ corrected: number; stillDiverging: number; failed: number; exhausted: number }> {
  let corrected = 0;
  let stillDiverging = 0;
  let failed = 0;
  let exhausted = 0;

  // Um unico instante para a rodada inteira: com `new Date()` por pedido, duas
  // linhas com o mesmo numero de tentativas ganhariam agendamentos diferentes
  // por causa do tempo de parede das chamadas, e o recuo deixaria de ser
  // reproduzivel — inclusive em teste.
  const now = new Date();

  for (const linha of fila) {
    const orderId = linha.externalOrderId;
    const attemptsFeitas = linha.attempts + 1;

    // O tender fresco da janela quando existe; senao o que ficou gravado na
    // deteccao. Linha vinda de rodada antiga ja saiu da janela, entao a unica
    // evidencia de quanto a Shopify diz ter recebido e' a que esta na tabela.
    const tenderCents = tenderPorPedido.get(orderId) ?? linha.tenderCents;

    try {
      // Sem `clearSplitWhenEmpty`: o default preserva o rateio quando a Admin
      // API nao devolve transacao. Chegamos neste pedido porque o
      // tenderTransactions REPORTOU dinheiro nele — uma resposta vazia do
      // endpoint de transacoes contradiz essa evidencia, e apagar o ledger com
      // base nela deixaria o dado pior do que antes do conserto. Preservando, a
      // divergencia sobrevive a medicao abaixo e segue na fila.
      await resolveShopifyOrderById(storeDomain, accessToken, orderId);

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
      const depois = await findLedgerGatewayTotalsByOrderIds([orderId]);
      const [medida] = detectOrderDivergences(new Map([[orderId, tenderCents]]), depois, -1);
      const aindaDiverge = Math.abs(medida?.deltaCents ?? 0) > TOLERANCE_CENTS;

      const decisao = decideRetryOutcome({
        aindaDiverge,
        attemptsFeitas,
        statusAnterior: linha.status,
        now,
      });
      await markDivergenceOutcome(
        orderId,
        decisao.status,
        medida?.ledgerCents ?? 0,
        decisao.nextAttemptAt
      );

      if (!aindaDiverge) corrected += 1;
      else {
        stillDiverging += 1;
        if (decisao.nextAttemptAt === null) exhausted += 1;
      }
    } catch (error) {
      // Um pedido que falha nao pode derrubar os outros. Mas tambem nao pode
      // sair de graca: a tentativa custou uma chamada, entao ela e' contada e a
      // linha recua igual — senao o pedido que falha por motivo permanente
      // voltaria em toda rodada e nunca chegaria a gente.
      failed += 1;
      const proxima = nextAttemptAfter(attemptsFeitas, now);
      if (proxima === null) exhausted += 1;

      logError("shopify_reconciliation_order_failed", {
        externalOrderId: orderId,
        attempts: attemptsFeitas,
        exhausted: proxima === null,
        error: error instanceof Error ? error.message : String(error),
      });

      try {
        await markDivergenceAttemptFailed(orderId, {
          nextAttemptAt: proxima,
          // Esgotou falhando: sai de `pendente` porque ninguem mais vem
          // busca-lo, e uma linha que parece fila sendo beco sem saida e'
          // exatamente o tipo de mentira que o painel nao pode contar.
          status: proxima === null ? "sem_correcao" : undefined,
        });
      } catch (bookkeepingError) {
        // Mesma regra de ouro do withJobRun: registrar nao derruba o trabalho.
        logError("shopify_reconciliation_attempt_bookkeeping_failed", {
          externalOrderId: orderId,
          error:
            bookkeepingError instanceof Error
              ? bookkeepingError.message
              : String(bookkeepingError),
        });
      }
    }
  }

  return { corrected, stillDiverging, failed, exhausted };
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
