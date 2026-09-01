/**
 * Fase 0 do plano de paridade Shopify: MEDIR antes de codar.
 *
 * Reproduz o relatorio "Pagamentos brutos por gateway" da Shopify para um dia e
 * decompoe, centavo a centavo, a diferenca contra o Sistema Financeiro.
 *
 * SOMENTE LEITURA: nao escreve em nenhuma tabela, nao chama nenhuma rota de
 * escrita. So SELECT no CORE e GET na Admin API.
 *
 * Uso:
 *   npx tsx scripts/diagnostico-pagamentos-shopify-dia.ts [--date=YYYY-MM-DD]
 *     [--concurrency=5] [--json] [--margem-horas=6]
 *
 * Por que existe (ver docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md e o plano):
 * em 30/08/2026 o sistema le R$ 178.925,88 / 1.127 e o relatorio da Shopify diz
 * R$ 181.332,81 / 1.143. O rateio por gateway explica no maximo R$ 491,36 disso
 * (o dinheiro que esta fora do gateway titular no dia inteiro). Este script
 * existe para descobrir onde estao os outros ~R$ 1.900 antes de escrever
 * qualquer codigo de producao.
 *
 * Tambem responde por que scripts/verify-shopify-values.ts le baixo: ele monta o
 * conjunto candidato com LITERAIS DE DATA no GraphQL
 * (`processed_at:>=2026-08-30`), cujo fuso de interpretacao nao esta fixado. Aqui
 * puxamos uma janela alargada UMA vez e simulamos as duas interpretacoes
 * possiveis em memoria, sem chamada extra — se uma delas reproduzir o numero do
 * script atual, a hipotese esta provada.
 */

import dotenv from "dotenv";

import { fetchShopifyOrderTransactions, type ShopifyOrderTransaction } from "../src/features/integration/shopify-order-transactions";
import { normalizeShopifyStoreDomain, stripWrappingQuotes } from "../src/features/integration/shopify-orders-sync";
import { getCorePool, withConnectionRetry } from "../src/features/transactions/mirror-events-repository";
import { addDaysToDayKey, dayWindowUtc } from "../src/lib/date-utils";

dotenv.config();

/** Mesmo fuso e mesmos filtros de kind/status do resto do sistema. */
const TIMEZONE = "America/Bahia";
const GROSS_KINDS = new Set(["sale", "capture", "change"]);
const SUCCESS_STATUS = "success";

type Args = {
  date: string;
  concurrency: number;
  json: boolean;
  margemHoras: number;
};

type TenderNode = {
  orderId: string;
  processedAt: Date;
  amountCents: number;
  test: boolean;
};

/** Uma transacao de pagamento da Shopify dentro da janela, com o pedido dela. */
type TxNaJanela = {
  orderId: string;
  gateway: string;
  kind: string;
  amountCents: number;
  processedAt: Date;
};

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

type Relatorio = {
  data: string;
  fuso: string;
  janelaUtc: { inicio: string; fimExclusivo: string };
  shopify: {
    totalCents: number;
    total: string;
    transacoes: number;
    paresPedidoGateway: number;
    pedidos: number;
    porGateway: Array<{
      gateway: string;
      transacoes: number;
      paresPedidoGateway: number;
      valor: string;
      valorCents: number;
    }>;
  };
  sistema: { totalCents: number; total: string; pedidos: number };
  diferenca: {
    cents: number;
    valor: string;
    classificacao: Array<{
      categoria: string;
      pedidos: number;
      valor: string;
      valorCents: number;
      exemplos: string[];
    }>;
    somaDasCategoriasCents: number;
    naoExplicadoCents: number;
  };
  conjuntoCandidato: {
    tenderTransactionsAlargado: number;
    candidatosJanelaReal: number;
    candidatosComMargem: number;
    candidatosSeLiteralDeDataForUtc: number;
  };
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const window = dayWindowUtc(args.date, TIMEZONE);

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");
  if (!storeDomain) throw new Error("SHOPIFY_STORE_URL ausente ou invalido.");
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN ausente.");

  console.error(`[1/5] tenderTransactions da janela alargada (${args.date} +- 1 dia)...`);
  const tenders = await loadTenderTransactions(storeDomain, accessToken, args.date);

  // Diagnostico do conjunto candidato: as duas leituras possiveis do literal de
  // data que o verify-shopify-values.ts usa hoje, calculadas sem chamada extra.
  const candidatosJanelaReal = orderIdsNaJanela(tenders, window.start, window.end);
  const janelaSeLiteralForUtc = {
    start: new Date(`${args.date}T00:00:00.000Z`),
    end: new Date(`${addDaysToDayKey(args.date, 1)}T00:00:00.000Z`),
  };
  const candidatosSeLiteralForUtc = orderIdsNaJanela(
    tenders,
    janelaSeLiteralForUtc.start,
    janelaSeLiteralForUtc.end
  );

  // Margem para pegar pedido cuja perna cai perto da meia-noite: se ele tem
  // dinheiro tanto dentro quanto fora da janela, precisamos ver o pedido inteiro.
  const margemMs = args.margemHoras * 60 * 60 * 1000;
  const candidatosComMargem = orderIdsNaJanela(
    tenders,
    new Date(window.start.getTime() - margemMs),
    new Date(window.end.getTime() + margemMs)
  );

  console.error(
    `      ${tenders.length} tender transactions | candidatos na janela real: ${candidatosJanelaReal.size} | ` +
      `com margem de ${args.margemHoras}h: ${candidatosComMargem.size}`
  );

  console.error(`[2/5] transacoes REST de ${candidatosComMargem.size} pedidos (portao de ~2 req/s)...`);
  const porPedido = await carregarTransacoes(
    storeDomain,
    accessToken,
    [...candidatosComMargem],
    args.concurrency
  );

  // Recorte final: so o que a Shopify conta no relatorio de pagamentos do dia.
  const naJanela: TxNaJanela[] = [];
  for (const [orderId, transacoes] of porPedido) {
    for (const tx of transacoes) {
      if (tx.status !== SUCCESS_STATUS) continue;
      if (!GROSS_KINDS.has(tx.kind)) continue;
      if (!tx.processedAt) continue;
      const processedAt = new Date(tx.processedAt);
      if (processedAt < window.start || processedAt >= window.end) continue;
      naJanela.push({ orderId, gateway: tx.gateway, kind: tx.kind, amountCents: tx.amountCents, processedAt });
    }
  }

  console.error(`[3/5] agregando por gateway...`);
  const porGateway = agregarPorGateway(naJanela);
  const shopifyTotalCents = naJanela.reduce((soma, tx) => soma + tx.amountCents, 0);
  const shopifyTransacoes = naJanela.length;
  const shopifyPares = new Set(naJanela.map((tx) => `${tx.orderId}|${tx.gateway}`)).size;
  const shopifyPedidos = new Set(naJanela.map((tx) => tx.orderId)).size;

  console.error(`[4/5] cruzando com o CORE...`);
  const pedidosShopify = [...new Set(naJanela.map((tx) => tx.orderId))];
  const core = await carregarLadoCore(window, pedidosShopify);

  console.error(`[5/5] classificando a diferenca...`);
  const classificacao = classificarDiferenca(naJanela, core);

  const relatorio: Relatorio = {
    data: args.date,
    fuso: TIMEZONE,
    janelaUtc: { inicio: window.start.toISOString(), fimExclusivo: window.end.toISOString() },

    shopify: {
      totalCents: shopifyTotalCents,
      total: brl(shopifyTotalCents),
      transacoes: shopifyTransacoes,
      paresPedidoGateway: shopifyPares,
      pedidos: shopifyPedidos,
      porGateway: porGateway.map((g) => ({
        gateway: g.gateway,
        transacoes: g.transacoes,
        paresPedidoGateway: g.pares,
        valor: brl(g.amountCents),
        valorCents: g.amountCents,
      })),
    },

    sistema: {
      totalCents: core.sistemaTotalCents,
      total: brl(core.sistemaTotalCents),
      pedidos: core.sistemaPedidos,
    },

    diferenca: {
      cents: shopifyTotalCents - core.sistemaTotalCents,
      valor: brl(shopifyTotalCents - core.sistemaTotalCents),
      classificacao: classificacao.categorias.map((c) => ({
        categoria: c.categoria,
        pedidos: c.pedidos.length,
        valor: brl(c.amountCents),
        valorCents: c.amountCents,
        exemplos: c.pedidos.slice(0, 5),
      })),
      somaDasCategoriasCents: classificacao.categorias.reduce((s, c) => s + c.amountCents, 0),
      naoExplicadoCents:
        shopifyTotalCents -
        core.sistemaTotalCents -
        classificacao.categorias.reduce((s, c) => s + c.amountCents, 0),
    },

    conjuntoCandidato: {
      tenderTransactionsAlargado: tenders.length,
      candidatosJanelaReal: candidatosJanelaReal.size,
      candidatosComMargem: candidatosComMargem.size,
      // A hipotese do plano: o verify-shopify-values.ts leu 1.119 candidatos em
      // 30/08. Se este numero bater, o literal de data e interpretado em UTC e o
      // script perde as ultimas 3 h do dia.
      candidatosSeLiteralDeDataForUtc: candidatosSeLiteralForUtc.size,
    },
  };

  if (args.json) {
    console.log(JSON.stringify(relatorio, null, 2));
  } else {
    imprimir(relatorio);
  }
}

/** Puxa tender transactions de [dia-1, dia+2) com limites ISO explicitos. */
async function loadTenderTransactions(
  storeDomain: string,
  accessToken: string,
  date: string
): Promise<TenderNode[]> {
  // Alargamos de proposito: o objetivo e NAO depender de como a Shopify
  // interpreta o filtro. Filtrar fino e responsabilidade do codigo, nao da query.
  const de = dayWindowUtc(addDaysToDayKey(date, -1), TIMEZONE).start;
  const ate = dayWindowUtc(addDaysToDayKey(date, 1), TIMEZONE).end;
  const searchQuery = `processed_at:>='${de.toISOString()}' AND processed_at:<='${ate.toISOString()}'`;

  const query = `
    query TenderTransactions($first: Int!, $after: String, $query: String!) {
      tenderTransactions(first: $first, after: $after, query: $query) {
        edges {
          node {
            processedAt
            test
            amount { amount }
            order { legacyResourceId }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const nodes: TenderNode[] = [];
  let after: string | undefined;

  do {
    const data = await shopifyGraphql(storeDomain, accessToken, query, { first: 250, after, query: searchQuery });
    const connection = data.tenderTransactions;
    for (const edge of connection.edges) {
      const orderId = edge.node.order?.legacyResourceId;
      if (!orderId) continue;
      nodes.push({
        orderId: String(orderId),
        processedAt: new Date(edge.node.processedAt),
        amountCents: Math.round(Number(edge.node.amount?.amount ?? 0) * 100),
        test: Boolean(edge.node.test),
      });
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return nodes;
}

function orderIdsNaJanela(tenders: TenderNode[], inicio: Date, fim: Date): Set<string> {
  const ids = new Set<string>();
  for (const tender of tenders) {
    if (tender.test) continue;
    if (tender.processedAt >= inicio && tender.processedAt < fim) ids.add(tender.orderId);
  }
  return ids;
}

async function carregarTransacoes(
  storeDomain: string,
  accessToken: string,
  orderIds: string[],
  concurrency: number
): Promise<Map<string, ShopifyOrderTransaction[]>> {
  const porPedido = new Map<string, ShopifyOrderTransaction[]>();
  let index = 0;
  let concluidos = 0;

  async function worker() {
    while (index < orderIds.length) {
      const orderId = orderIds[index++];
      const transacoes = await fetchShopifyOrderTransactions(storeDomain, accessToken, orderId);
      porPedido.set(orderId, transacoes);
      concluidos += 1;
      if (concluidos % 100 === 0) {
        console.error(`      ${concluidos}/${orderIds.length} pedidos...`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return porPedido;
}

function agregarPorGateway(transacoes: TxNaJanela[]) {
  const mapa = new Map<string, { transacoes: number; amountCents: number; pares: Set<string> }>();

  for (const tx of transacoes) {
    const atual = mapa.get(tx.gateway) ?? { transacoes: 0, amountCents: 0, pares: new Set<string>() };
    atual.transacoes += 1;
    atual.amountCents += tx.amountCents;
    atual.pares.add(tx.orderId);
    mapa.set(tx.gateway, atual);
  }

  return [...mapa.entries()]
    .map(([gateway, v]) => ({ gateway, transacoes: v.transacoes, amountCents: v.amountCents, pares: v.pares.size }))
    .sort((a, b) => b.amountCents - a.amountCents);
}

type LadoCore = {
  sistemaTotalCents: number;
  sistemaPedidos: number;
  /** order_key -> valor materializado, para os pedidos que a Shopify aponta */
  financialPorPedido: Map<string, { amountCents: number; occurredAt: Date }>;
  /** pedidos da Shopify que existem em financial_orders DENTRO da janela */
  naJanelaNoSistema: Set<string>;
  /** pedidos da Shopify presentes no mirror (qualquer data) */
  noMirror: Set<string>;
  /** pedidos que o sistema tem na janela e a Shopify nao aponta */
  sobrandoNoSistema: Array<{ orderKey: string; amountCents: number }>;
};

async function carregarLadoCore(window: { start: Date; end: Date }, pedidosShopify: string[]): Promise<LadoCore> {
  const pool = getCorePool();
  if (!pool) throw new Error("CORE_DB_URL ausente: sem lado Sistema Financeiro para comparar.");

  const totalRes = await withConnectionRetry(() =>
    pool.query<{ pedidos: string; bruto: string | null }>(
      `SELECT count(*) AS pedidos, sum(amount_cents) AS bruto
       FROM integration.financial_orders
       WHERE source = 'shopify' AND occurred_at >= $1 AND occurred_at < $2`,
      [window.start, window.end]
    )
  );

  const foRes = await withConnectionRetry(() =>
    pool.query<{ order_key: string; amount_cents: string; occurred_at: Date }>(
      `SELECT order_key, amount_cents, occurred_at
       FROM integration.financial_orders
       WHERE source = 'shopify' AND order_key = ANY($1::text[])`,
      [pedidosShopify]
    )
  );

  const mirrorRes = await withConnectionRetry(() =>
    pool.query<{ external_order_id: string }>(
      `SELECT DISTINCT external_order_id
       FROM mirror.raw_payloads
       WHERE source = 'shopify' AND external_order_id = ANY($1::text[])`,
      [pedidosShopify]
    )
  );

  const sobrandoRes = await withConnectionRetry(() =>
    pool.query<{ order_key: string; amount_cents: string }>(
      `SELECT order_key, amount_cents
       FROM integration.financial_orders
       WHERE source = 'shopify' AND occurred_at >= $1 AND occurred_at < $2
         AND NOT (order_key = ANY($3::text[]))
       ORDER BY amount_cents DESC`,
      [window.start, window.end, pedidosShopify]
    )
  );

  const financialPorPedido = new Map<string, { amountCents: number; occurredAt: Date }>();
  const naJanelaNoSistema = new Set<string>();
  for (const row of foRes.rows) {
    financialPorPedido.set(row.order_key, {
      amountCents: Number(row.amount_cents),
      occurredAt: row.occurred_at,
    });
    if (row.occurred_at >= window.start && row.occurred_at < window.end) naJanelaNoSistema.add(row.order_key);
  }

  return {
    sistemaTotalCents: Number(totalRes.rows[0]?.bruto ?? 0),
    sistemaPedidos: Number(totalRes.rows[0]?.pedidos ?? 0),
    financialPorPedido,
    naJanelaNoSistema,
    noMirror: new Set(mirrorRes.rows.map((r) => r.external_order_id)),
    sobrandoNoSistema: sobrandoRes.rows.map((r) => ({
      orderKey: r.order_key,
      amountCents: Number(r.amount_cents),
    })),
  };
}

type Categoria = { categoria: string; amountCents: number; pedidos: string[] };

/**
 * Decompoe (Shopify - Sistema) em categorias que somam exatamente a diferenca.
 *
 * Para cada pedido que a Shopify conta na janela comparamos o quanto ela conta
 * ali contra o quanto o sistema conta ali (0 quando o pedido nao esta na janela
 * do sistema). O motivo de cada diferenca vira uma categoria. Depois somamos, com
 * sinal negativo, o que o sistema tem na janela e a Shopify nao aponta.
 */
function classificarDiferenca(naJanela: TxNaJanela[], core: LadoCore): { categorias: Categoria[] } {
  const shopifyPorPedido = new Map<string, number>();
  for (const tx of naJanela) {
    shopifyPorPedido.set(tx.orderId, (shopifyPorPedido.get(tx.orderId) ?? 0) + tx.amountCents);
  }

  const cats = new Map<string, Categoria>();
  const somar = (categoria: string, cents: number, pedido: string) => {
    if (cents === 0) return;
    const atual = cats.get(categoria) ?? { categoria, amountCents: 0, pedidos: [] };
    atual.amountCents += cents;
    atual.pedidos.push(pedido);
    cats.set(categoria, atual);
  };

  for (const [orderId, shopifyCents] of shopifyPorPedido) {
    const noSistema = core.naJanelaNoSistema.has(orderId);
    const materializado = core.financialPorPedido.get(orderId);
    const sistemaCents = noSistema ? (materializado?.amountCents ?? 0) : 0;
    const delta = shopifyCents - sistemaCents;
    if (delta === 0) continue;

    if (!core.noMirror.has(orderId)) {
      somar("pedido_ausente_no_mirror", delta, orderId);
    } else if (!materializado) {
      // Esta no mirror mas nunca virou linha: rejeitado na materializacao
      // (financial_status != paid, valor nao positivo, etc).
      somar("pedido_nao_materializado", delta, orderId);
    } else if (!noSistema) {
      // Existe no sistema, mas datado em outro dia.
      somar("data_divergente", delta, orderId);
    } else {
      // Mesmo pedido nos dois lados, na mesma janela, com valores diferentes:
      // parte do dinheiro do pedido tem processed_at fora da janela.
      somar("perna_fora_da_janela", delta, orderId);
    }
  }

  for (const sobra of core.sobrandoNoSistema) {
    somar("sistema_conta_shopify_nao", -sobra.amountCents, sobra.orderKey);
  }

  return { categorias: [...cats.values()].sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents)) };
}

type TenderTransactionsResponse = {
  tenderTransactions: {
    edges: Array<{
      node: {
        processedAt: string;
        test: boolean;
        amount: { amount: string } | null;
        order: { legacyResourceId: string } | null;
      };
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
};

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  retries = 2
): Promise<TenderTransactionsResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
      const json = await response.json();
      if (!response.ok || json.errors) {
        throw new Error(`Shopify GraphQL falhou: ${response.status} ${JSON.stringify(json.errors ?? json)}`);
      }
      return json.data;
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

function imprimir(r: Relatorio) {
  console.log(`\n=== Pagamentos Shopify x Sistema Financeiro — ${r.data} (${r.fuso}) ===`);
  console.log(`Janela UTC: ${r.janelaUtc.inicio} -> ${r.janelaUtc.fimExclusivo}\n`);

  console.log("-- Shopify: pagamentos brutos por gateway --");
  for (const g of r.shopify.porGateway) {
    console.log(
      `  ${String(g.gateway).padEnd(30)} transacoes=${String(g.transacoes).padStart(5)}` +
        `  pares=${String(g.paresPedidoGateway).padStart(5)}  ${g.valor.padStart(14)}`
    );
  }
  console.log(
    `  ${"TOTAL".padEnd(30)} transacoes=${String(r.shopify.transacoes).padStart(5)}` +
      `  pares=${String(r.shopify.paresPedidoGateway).padStart(5)}  ${r.shopify.total.padStart(14)}` +
      `  (pedidos distintos: ${r.shopify.pedidos})`
  );

  console.log(`\n-- Sistema Financeiro (integration.financial_orders) --`);
  console.log(`  pedidos=${r.sistema.pedidos}  ${r.sistema.total}`);

  console.log(`\n-- Diferenca: ${r.diferenca.valor} --`);
  for (const c of r.diferenca.classificacao) {
    console.log(
      `  ${String(c.categoria).padEnd(30)} pedidos=${String(c.pedidos).padStart(5)}  ${c.valor.padStart(14)}` +
        `  ex.: ${c.exemplos.join(", ")}`
    );
  }
  console.log(`  ${"NAO EXPLICADO".padEnd(30)} ${brl(r.diferenca.naoExplicadoCents).padStart(28)}`);

  console.log(`\n-- Conjunto candidato (diagnostico do verify-shopify-values.ts) --`);
  console.log(`  tender transactions na janela alargada : ${r.conjuntoCandidato.tenderTransactionsAlargado}`);
  console.log(`  candidatos na janela real (-03:00)     : ${r.conjuntoCandidato.candidatosJanelaReal}`);
  console.log(`  candidatos com margem                  : ${r.conjuntoCandidato.candidatosComMargem}`);
  console.log(`  candidatos se o literal for lido em UTC: ${r.conjuntoCandidato.candidatosSeLiteralDeDataForUtc}`);
  console.log(
    `  (o verify-shopify-values.ts leu 1.119 em 30/08 — se o numero de cima bater, a hipotese do fuso esta provada)`
  );
}

function parseArgs(argv: string[]): Args {
  const parsed: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    parsed[key] = value ?? true;
  }

  const date = typeof parsed.date === "string" ? parsed.date : ontemEm(TIMEZONE);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date invalido: ${date}`);

  return {
    date,
    concurrency: typeof parsed.concurrency === "string" ? Number(parsed.concurrency) : 5,
    json: Boolean(parsed.json),
    margemHoras: typeof parsed["margem-horas"] === "string" ? Number(parsed["margem-horas"]) : 6,
  };
}

function ontemEm(timezone: string): string {
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: timezone });
  return addDaysToDayKey(hoje, -1);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
