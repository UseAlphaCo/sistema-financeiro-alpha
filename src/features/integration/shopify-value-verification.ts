/**
 * Verificacao de valores: Sistema Financeiro vs Shopify (v2).
 *
 * Logica pura compartilhada entre o script CLI (scripts/verify-shopify-values.ts)
 * e a rota de checagem automatizada (/api/internal/cron/shopify-verify).
 *
 * ─── O que mudou na v2, e por que ───────────────────────────────────────────
 *
 * A v1 montava o lado Shopify fazendo **uma chamada REST por pedido candidato**
 * — ~1.700 por dia, serializadas pelo portao de 500 ms do bucket da Shopify:
 * cerca de 850 s. A rota era a unica das quatro sem `maxDuration` declarado.
 * Ela nao completava em producao, e o ramo de auto-alinhamento nunca chegou a
 * executar.
 *
 * Nao precisa disso. O ledger de rateio
 * (integration.shopify_order_payment_gateway_split) foi construido por
 * exatamente aquelas chamadas e ja esta persistido; a medicao de 08/09/2026 nao
 * achou **nenhuma** divergencia entre ele e `spr.total_amount_cents` em 19.237
 * pedidos. Entao a verificacao passa a ter tres pontas em vez de duas:
 *
 *   1. Sistema x Ledger   — mede defasagem de MATERIALIZACAO (tudo em SQL)
 *   2. Ledger x Shopify   — mede deriva do lado da SHOPIFY, via
 *                            tenderTransactions (~10 chamadas GraphQL, nao 1.700)
 *
 * Separar as duas importa: quando o numero da tela nao bate, a v1 dizia so "nao
 * bate". Estas duas pontas dizem de que lado esta o problema.
 *
 * ─── Limite conhecido da ponta 2 ────────────────────────────────────────────
 *
 * tenderTransactions nao emite entrada para pedido pago inteiramente com
 * credito na loja (medido em 30/08 e 07/09/2026). Por isso a comparacao roda
 * **so sobre os pedidos que o tender reporta**, e os pedidos que existem no
 * ledger e nao no tender saem contados a parte, como ponto cego declarado — em
 * vez de virarem uma divergencia permanente que ninguem consegue fechar.
 */

import { computeCashFlow } from "@/features/cash-flow/service";
import { classifyPaymentMethod } from "@/features/transactions/payment-method-filter";
import { getCorePool, withConnectionRetry } from "@/features/transactions/mirror-events-repository";
// dayWindowUtc/zonedDateToUtc nasceram aqui e eram a unica conversao de fuso
// correta do repo. Foram para @/lib/date-utils para virar a convencao unica do
// sistema, em vez de conviverem com as fronteiras por fuso de processo.
import { dayWindowUtc } from "@/lib/date-utils";

import {
  findLedgerGatewayTotalsByOrderIds,
  getLedgerDaySummary,
  type LedgerDaySummary,
} from "./shopify-payment-resolution-repository";
import { normalizeShopifyStoreDomain, stripWrappingQuotes } from "./shopify-orders-sync";
import {
  fetchTenderTransactions,
  tenderOrderIdsInWindow,
  tenderTotalsByOrder,
  widenedWindowForDay,
} from "./shopify-tender-transactions";
// O rotulo mora no modulo de leitura, e nao aqui, para que ele continue puro:
// o painel precisa da constante e nao pode arrastar computeCashFlow e o pool do
// CORE junto so para reconhecer um rotulo. Mesmo arranjo de job-names.ts.
import { LEDGER_VS_SHOPIFY_METRIC_LABEL } from "./verification-run-view";

export const VERIFICATION_TIMEZONE = "America/Bahia";

/** Classificacao cujas pernas o tenderTransactions nunca reporta. */
const STORE_CREDIT_METHOD = "store_credit";

export type VerificationMetric = {
  label: string;
  financeiro: string;
  shopify: string;
  diff: string;
  diffPct: string;
  diverges: boolean;
};

export type SyncFreshness = {
  mirrorOrders: number;
  unresolvedOrders: number;
};

/**
 * Sinais de fila drenada.
 *
 * A v1 usava um proxy de horas: exigia 12 h desde o fim do dia local, o que so
 * acontece as 12:00 BRT. Como o cron rodava as 06:00 BRT,
 * `hoursSinceWindowEnd` valia ~6 e **`isMature` era sempre falso** — o ramo de
 * alerta e auto-alinhamento nunca executou em producao. Nao ha comportamento
 * estabelecido sendo regredido aqui.
 *
 * O substituto nao pergunta que horas sao, pergunta se o trabalho acabou. Cada
 * sinal cobre uma etapa distinta do pipeline, e nenhum deles depende do
 * resultado da propria verificacao — senao "maduro" passaria a significar "sem
 * divergencia" e o alerta nunca dispararia por construcao.
 */
export type MaturitySignal = {
  /** Pedidos do dia no mirror que o job de resolucao ainda nao visitou. */
  unresolvedOrders: number;
  /** Pedidos materializados do dia sem nenhuma perna no ledger de rateio. */
  ordersWithoutLedger: number;
  /** Quando a materializacao passou por este dia pela ultima vez. */
  lastMaterializedAt: string | null;
  /** A materializacao rodou DEPOIS de o dia fechar (viu o dia inteiro). */
  materializedAfterWindow: boolean;
  isMature: boolean;
};

/**
 * Um pedido em que o ledger e a Shopify discordam do total.
 *
 * O laco da ponta 2 sempre soube disto — calculava o delta por pedido e guardava
 * so o contador. Sem a identidade, o painel consegue dizer "3 pedidos" e nunca
 * QUAIS, e nenhum conserto automatico e' possivel. E' a materia-prima da
 * reconciliacao (shopify-reconciliation.ts).
 */
export type OrderDivergence = {
  orderId: string;
  /** Total do pedido segundo o tenderTransactions. */
  tenderCents: number;
  /** Total comparavel do ledger: ja SEM as pernas de credito na loja. */
  ledgerCents: number;
  /** tender - ledger. Positivo = a Shopify recebeu mais do que registramos. */
  deltaCents: number;
};

/** Ponta 2: o ledger contra o que a Shopify diz ter recebido. */
export type LedgerVsShopify = {
  /** Pedidos comparados: os que o tenderTransactions reporta na janela. */
  comparedOrders: number;
  /** Quantos deles tem total diferente entre ledger e Shopify. */
  divergentOrders: number;
  /** Soma dos desvios em modulo, para nao deixar sobra cancelar falta. */
  driftCents: number;
  driftFormatted: string;
  /** Dinheiro de credito na loja no dia, que o tender estruturalmente nao ve. */
  storeCreditBlindSpotCents: number;
  storeCreditBlindSpotFormatted: string;
  /** Pedidos do dia pagos 100% com credito na loja: invisiveis ao tender. */
  ordersOnlyInLedger: number;
  /** Entradas negativas do tender descartadas. Ver tenderTotalsByOrder. */
  tenderNegativeEntries: number;
};

/**
 * A ponta 2 com a identidade dos pedidos, e nao so os agregados.
 *
 * E' um tipo a parte, e nao um campo opcional em LedgerVsShopify, para que o
 * compilador garanta o que um comentario so pediria: `VerificationReport` carrega
 * `LedgerVsShopify` puro e **nao tem como** levar a lista junto. O relatorio
 * inteiro e' serializado em job_runs.result e relido pelo painel a cada 60 s; um
 * dia ruim com dezenas de pedidos engordaria esse jsonb sem que ninguem leia a
 * lista por la. Quem precisa dela e' a reconciliacao, que a consome em memoria e
 * persiste em tabela propria.
 */
export type LedgerVsShopifyDetailed = LedgerVsShopify & {
  /** Pedidos divergentes, em ordem decrescente de |delta|. */
  divergences: OrderDivergence[];
};

export type VerificationReport = {
  date: string;
  timezone: string;
  windowUtc: { start: string; endExclusive: string };
  metrics: VerificationMetric[];
  syncFreshness: SyncFreshness;
  maturity: MaturitySignal;
  ledgerVsShopify: LedgerVsShopify;
};

export type VerificationOptions = {
  date?: string;
  toleranceCents?: number;
};

export async function buildVerificationReport(options: VerificationOptions = {}): Promise<VerificationReport> {
  const toleranceCents = options.toleranceCents ?? 1;
  const date = options.date ?? yesterdayInTimeZone(VERIFICATION_TIMEZONE);
  const window = dayWindowUtc(date, VERIFICATION_TIMEZONE);

  const [financeiro, ledger, freshness, materialization] = await Promise.all([
    computeCashFlow({ startDate: date, endDate: date, marketplace: "Shopify" }),
    getLedgerDaySummary(window),
    loadSyncFreshness(window),
    loadMaterializationSignals(window),
  ]);

  // A ponta 2 depende do conjunto de pedidos do ledger, entao vem depois.
  const detalhado = await compareLedgerAgainstShopify(date, window, ledger, toleranceCents);
  const ledgerVsShopify = semDivergencias(detalhado);

  const financeiroSource = financeiro.bySource.find((entry) => entry.source === "Shopify");
  const financeiroGrossCents = financeiroSource?.grossCents ?? 0;
  const financeiroOrderCount = financeiroSource?.transactionCount ?? 0;
  // Na base de pagamentos a contagem do sistema ja e de transacoes, e o
  // comparavel do lado do ledger passa a ser o numero de transacoes tambem.
  const contagemLedger =
    financeiroSource?.basis === "payments" ? ledger.transactionCount : ledger.orderIds.size;
  const rotuloContagem =
    financeiroSource?.basis === "payments"
      ? "Nº de transações (pagamentos processados)"
      : "Nº de transações (pedidos pagos)";

  return {
    date,
    timezone: VERIFICATION_TIMEZONE,
    windowUtc: { start: window.start.toISOString(), endExclusive: window.end.toISOString() },
    metrics: [
      buildMetric("Faturamento bruto", financeiroGrossCents, ledger.grossCents, toleranceCents, formatMoney),
      buildMetric(rotuloContagem, financeiroOrderCount, contagemLedger, 0, (value) => String(value)),
      // Por gateway, e nao so o total: em 30/08/2026 o credito na loja estava
      // R$ 190,70 ACIMA e o cartao R$ 2.563,79 abaixo. No total as duas se
      // cancelam parcialmente e o alarme subestima o tamanho do problema.
      ...buildGatewayMetrics(financeiro.byPaymentMethod, ledger, toleranceCents),
      buildLedgerVsShopifyMetric(ledgerVsShopify, toleranceCents),
    ],
    syncFreshness: freshness,
    maturity: buildMaturity(freshness, materialization, window),
    ledgerVsShopify,
  };
}

/**
 * Uma metrica por forma de pagamento, comparando o que o Fluxo de Caixa mostra
 * com o que o ledger de rateio registrou.
 *
 * Agrupa os gateways crus pela MESMA classificacao que o sistema usa
 * (classifyPaymentMethod), senao "Pix (3% de desconto)" nunca casaria com "pix".
 */
function buildGatewayMetrics(
  financeiroByMethod: Array<{ paymentMethod: string; grossCents: number }>,
  ledger: LedgerDaySummary,
  toleranceCents: number
): VerificationMetric[] {
  const ledgerByMethod = new Map<string, number>();
  for (const bucket of ledger.byGateway) {
    const method = classifyPaymentMethod(bucket.gatewayRaw);
    ledgerByMethod.set(method, (ledgerByMethod.get(method) ?? 0) + bucket.amountCents);
  }

  const financeiroByMethodMap = new Map(financeiroByMethod.map((row) => [row.paymentMethod, row.grossCents]));
  const metodos = [...new Set([...financeiroByMethodMap.keys(), ...ledgerByMethod.keys()])].sort();

  return metodos.map((metodo) =>
    buildMetric(
      `Faturamento — ${metodo}`,
      financeiroByMethodMap.get(metodo) ?? 0,
      ledgerByMethod.get(metodo) ?? 0,
      toleranceCents,
      formatMoney
    )
  );
}

/**
 * Ponta 2 como metrica.
 *
 * `diverges` sai do desvio POR PEDIDO acumulado em modulo, e nao da diferenca
 * entre os dois totais: um pedido R$ 100 a mais e outro R$ 100 a menos zeram o
 * total e continuam sendo dois pedidos errados.
 */
function buildLedgerVsShopifyMetric(
  comparison: LedgerVsShopify,
  toleranceCents: number
): VerificationMetric {
  return {
    label: LEDGER_VS_SHOPIFY_METRIC_LABEL,
    financeiro: `${comparison.comparedOrders} pedidos comparados`,
    shopify: `${comparison.storeCreditBlindSpotFormatted} em crédito na loja (invisível)`,
    diff: comparison.driftFormatted,
    diffPct: `${comparison.divergentOrders} pedido(s)`,
    diverges: comparison.driftCents > toleranceCents,
  };
}

async function compareLedgerAgainstShopify(
  date: string,
  window: { start: Date; end: Date },
  ledger: LedgerDaySummary,
  toleranceCents: number
): Promise<LedgerVsShopifyDetailed> {
  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");
  if (!storeDomain) throw new Error("SHOPIFY_STORE_URL ausente ou invalido.");
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN ausente.");

  // Janela alargada: o candidato sai do dia, mas o TOTAL do pedido precisa
  // enxergar perna que caiu do outro lado da meia-noite.
  const widened = widenedWindowForDay(date, VERIFICATION_TIMEZONE);
  const tenders = await fetchTenderTransactions(storeDomain, accessToken, widened.from, widened.to);

  const candidatos = tenderOrderIdsInWindow(tenders, window.start, window.end);
  const { byOrder: tenderPorPedido, negativeEntries } = tenderTotalsByOrder(tenders, candidatos);
  const ledgerPorPedido = await findLedgerGatewayTotalsByOrderIds([...candidatos]);

  const divergences = detectOrderDivergences(tenderPorPedido, ledgerPorPedido, toleranceCents);
  const driftCents = divergences.reduce((sum, item) => sum + Math.abs(item.deltaCents), 0);

  let ordersOnlyInLedger = 0;
  for (const orderId of ledger.orderIds) {
    if (!tenderPorPedido.has(orderId)) ordersOnlyInLedger += 1;
  }

  const storeCreditBlindSpotCents = ledger.byGateway
    .filter((bucket) => classifyPaymentMethod(bucket.gatewayRaw) === STORE_CREDIT_METHOD)
    .reduce((sum, bucket) => sum + bucket.amountCents, 0);

  return {
    comparedOrders: tenderPorPedido.size,
    divergentOrders: divergences.length,
    driftCents,
    driftFormatted: formatMoney(driftCents),
    storeCreditBlindSpotCents,
    storeCreditBlindSpotFormatted: formatMoney(storeCreditBlindSpotCents),
    ordersOnlyInLedger,
    tenderNegativeEntries: negativeEntries,
    divergences,
  };
}

/**
 * Os agregados da ponta 2, sem a lista de pedidos.
 *
 * Copia campo a campo em vez de fazer rest-spread do detalhado: assim, um campo
 * novo so entra no jsonb de job_runs se alguem o acrescentar AQUI, de proposito.
 * Com spread, qualquer campo novo em LedgerVsShopifyDetailed vazaria sozinho
 * para o `result` que o painel rele a cada 60 s.
 */
function semDivergencias(detalhado: LedgerVsShopifyDetailed): LedgerVsShopify {
  return {
    comparedOrders: detalhado.comparedOrders,
    divergentOrders: detalhado.divergentOrders,
    driftCents: detalhado.driftCents,
    driftFormatted: detalhado.driftFormatted,
    storeCreditBlindSpotCents: detalhado.storeCreditBlindSpotCents,
    storeCreditBlindSpotFormatted: detalhado.storeCreditBlindSpotFormatted,
    ordersOnlyInLedger: detalhado.ordersOnlyInLedger,
    tenderNegativeEntries: detalhado.tenderNegativeEntries,
  };
}

/**
 * Quais pedidos discordam entre o tender e o ledger, do maior desvio para o menor.
 *
 * Pura de proposito: e' a regra de deteccao que a verificacao diaria e a
 * reconciliacao (shopify-reconciliation.ts) precisam aplicar **identicamente**.
 * Duplicar o laco nos dois lugares abriria espaco para uma das copias esquecer a
 * exclusao de credito na loja, e o sintoma seria ~18 divergencias por dia que
 * nunca fecham — exatamente o que comparableLedgerCents existe para evitar.
 *
 * Itera pelo tender, e nao pelo ledger: pedido ausente do tender e' ausencia de
 * informacao (o ponto cego do credito na loja), nunca ausencia de dinheiro. Ja o
 * contrario — o tender aponta e o ledger nao conhece — e' desvio integral, e cai
 * naturalmente aqui com `ledgerCents` zero.
 */
export function detectOrderDivergences(
  tenderPorPedido: ReadonlyMap<string, number>,
  ledgerPorPedido: ReadonlyMap<string, Map<string, number>>,
  toleranceCents: number
): OrderDivergence[] {
  const divergences: OrderDivergence[] = [];

  for (const [orderId, tenderCents] of tenderPorPedido) {
    const ledgerCents = comparableLedgerCents(ledgerPorPedido.get(orderId));
    const deltaCents = tenderCents - ledgerCents;
    if (Math.abs(deltaCents) <= toleranceCents) continue;
    divergences.push({ orderId, tenderCents, ledgerCents, deltaCents });
  }

  // Maior dinheiro primeiro: quem consome tem teto de correcoes por rodada, e o
  // que fica para a proxima precisa ser o menos relevante, nao o que calhou de
  // vir por ultimo na iteracao do Map.
  divergences.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));

  return divergences;
}

/**
 * Quanto do pedido, no ledger, o tenderTransactions tem chance de reportar.
 *
 * Exclui as pernas de credito na loja. Medido em 07/09/2026 e fechado ao
 * centavo: 18 dos 786 pedidos do dia divergiam entre ledger e tender, num total
 * de R$ 1.461,25, e esse valor e' **exatamente** a soma das pernas
 * `shopify_store_credit` desses 18 pedidos. Em nenhum deles o tender apontava
 * mais do que o ledger — zero pedidos na direcao que importaria.
 *
 * O ponto cego, entao, e' por PERNA e nao por pedido: a Shopify nao emite
 * tender transaction para credito na loja nem quando ele paga o pedido inteiro
 * (o caso ja conhecido) nem quando paga so uma parte dele (este). Sem esta
 * exclusao, todo pedido com qualquer parcela de credito viraria divergencia
 * permanente — ~18 falsos positivos por dia que nunca fechariam.
 */
function comparableLedgerCents(porGateway: Map<string, number> | undefined): number {
  if (!porGateway) return 0;

  let total = 0;
  for (const [gatewayRaw, amountCents] of porGateway) {
    if (classifyPaymentMethod(gatewayRaw) === STORE_CREDIT_METHOD) continue;
    total += amountCents;
  }
  return total;
}

function buildMaturity(
  freshness: SyncFreshness,
  materialization: MaterializationSignals,
  window: { start: Date; end: Date }
): MaturitySignal {
  const materializedAfterWindow =
    materialization.lastMaterializedAt !== null && materialization.lastMaterializedAt >= window.end;

  return {
    unresolvedOrders: freshness.unresolvedOrders,
    ordersWithoutLedger: materialization.ordersWithoutLedger,
    lastMaterializedAt: materialization.lastMaterializedAt?.toISOString() ?? null,
    materializedAfterWindow,
    isMature:
      freshness.unresolvedOrders === 0 &&
      materialization.ordersWithoutLedger === 0 &&
      materializedAfterWindow,
  };
}

function buildMetric(
  label: string,
  financeiroValue: number,
  shopifyValue: number,
  toleranceCents: number,
  format: (value: number) => string
): VerificationMetric {
  const diff = financeiroValue - shopifyValue;
  const diffPct = shopifyValue !== 0 ? (diff / shopifyValue) * 100 : financeiroValue === 0 ? 0 : 100;

  return {
    label,
    financeiro: format(financeiroValue),
    shopify: format(shopifyValue),
    diff: format(diff),
    diffPct: `${diffPct.toFixed(2)}%`,
    diverges: Math.abs(diff) > toleranceCents,
  };
}

type MaterializationSignals = {
  lastMaterializedAt: Date | null;
  ordersWithoutLedger: number;
};

/**
 * Estado da materializacao do dia: quando passou e o que deixou sem rateio.
 *
 * Ancorado em integration.financial_orders, com `source_key` (a unica das duas
 * colunas de origem que tem indice com occurred_at). O NOT EXISTS usa a PK do
 * ledger, entao e' sondagem de indice — ~1.000 pedidos no dia.
 */
async function loadMaterializationSignals(window: { start: Date; end: Date }): Promise<MaterializationSignals> {
  const pool = getCorePool();
  if (!pool) return { lastMaterializedAt: null, ordersWithoutLedger: 0 };

  try {
    const result = await withConnectionRetry(() =>
      pool.query<{ last_materialized_at: Date | null; without_ledger: string }>(
        `
        SELECT max(fo.materialized_at) AS last_materialized_at,
               count(*) FILTER (
                 WHERE NOT EXISTS (
                   SELECT 1 FROM integration.shopify_order_payment_gateway_split s
                    WHERE s.external_order_id = fo.order_key
                 )
               )::text AS without_ledger
          FROM integration.financial_orders fo
         WHERE fo.source_key = 'shopify'
           AND fo.occurred_at >= $1
           AND fo.occurred_at < $2
        `,
        [window.start, window.end]
      )
    );

    return {
      lastMaterializedAt: result.rows[0]?.last_materialized_at ?? null,
      ordersWithoutLedger: Number(result.rows[0]?.without_ledger ?? 0),
    };
  } catch (err) {
    // Tabela ausente neste ambiente. Sem sinal e' "nao maduro", nunca "maduro"
    // — errar para o lado de nao disparar alinhamento automatico.
    if (err instanceof Error && /does not exist/i.test(err.message)) {
      return { lastMaterializedAt: null, ordersWithoutLedger: 0 };
    }
    throw err;
  }
}

async function loadSyncFreshness(window: { start: Date; end: Date }): Promise<SyncFreshness> {
  const pool = getCorePool();
  if (!pool) return { mirrorOrders: 0, unresolvedOrders: 0 };

  // Reaproveita o pool compartilhado (getCorePool) e o retry de conexao
  // (withConnectionRetry) ja usados por listMirrorTransactions: a mesma
  // classe de erro transitorio (57014/conexao derrubada em conexao recem
  // aberta contra o CORE_DB_URL) ja foi diagnosticada e resolvida la — sem
  // isso, esta rota rodando sozinha a cada hora reabriria conexao do zero
  // toda vez e ficaria exposta ao mesmo problema sem nenhum retry.
  const mirrorResult = await withConnectionRetry(() =>
    pool.query<{ mirror_orders: string }>(
      `
      SELECT count(DISTINCT rp.external_order_id) AS mirror_orders
      FROM mirror.raw_payloads rp
      WHERE rp.source = 'shopify'
        AND rp.payload_json IS NOT NULL
        AND (rp.payload_json->>'created_at')::timestamptz >= $1
        AND (rp.payload_json->>'created_at')::timestamptz < $2
      `,
      [window.start, window.end]
    )
  );
  const mirrorOrders = Number(mirrorResult.rows[0]?.mirror_orders ?? 0);

  try {
    const unresolvedResult = await withConnectionRetry(() =>
      pool.query<{ unresolved_orders: string }>(
        `
        SELECT count(DISTINCT rp.external_order_id) AS unresolved_orders
        FROM mirror.raw_payloads rp
        LEFT JOIN integration.shopify_order_payment_resolution spr
          ON spr.external_order_id = rp.external_order_id
        WHERE rp.source = 'shopify'
          AND rp.payload_json IS NOT NULL
          AND (rp.payload_json->>'created_at')::timestamptz >= $1
          AND (rp.payload_json->>'created_at')::timestamptz < $2
          AND spr.external_order_id IS NULL
        `,
        [window.start, window.end]
      )
    );
    return { mirrorOrders, unresolvedOrders: Number(unresolvedResult.rows[0]?.unresolved_orders ?? 0) };
  } catch (err) {
    // Tabela do job de resolução pode não existir ainda neste ambiente
    // (criada sob demanda por ensureShopifyPaymentResolutionTable). Não é
    // erro fatal para a verificação de faturamento/contagem.
    if (err instanceof Error && /does not exist/i.test(err.message)) {
      return { mirrorOrders, unresolvedOrders: mirrorOrders };
    }
    throw err;
  }
}

export function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function yesterdayInTimeZone(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}
