import { addDaysToDayKey, dayWindowUtc } from "@/lib/date-utils";

/**
 * tenderTransactions da Shopify: o que a loja realmente recebeu, por pagamento.
 *
 * Extraido de scripts/diagnostico-pagamentos-shopify-dia.ts, que tinha a versao
 * CORRETA. A versao que vivia em shopify-value-verification.ts montava o filtro
 * com literais de data nus (`processed_at:>=2026-08-30`), cujo fuso de
 * interpretacao nao esta fixado pela API — e a Shopify os lia em UTC, fazendo o
 * script perder as ultimas 3 h de todo dia. Consolidar na versao correta e' o
 * ponto principal desta extracao; ter um lugar so e' o beneficio secundario.
 *
 * PONTO CEGO CONHECIDO, medido duas vezes (30/08 e 07/09/2026): a Shopify **nao
 * emite tender transaction** para pedido pago inteiramente com credito na loja.
 * Em 30/08 apareciam 13 pagamentos de credito (R$ 1.534,16) contra os 22
 * (R$ 3.050,96) do relatorio oficial. Quem consome este modulo precisa tratar
 * "ausente do tender" como ausencia de informacao, nunca como ausencia de
 * dinheiro.
 */

const GRAPHQL_API_VERSION = "2024-10";
const PAGE_SIZE = 250;

export type TenderTransaction = {
  orderId: string;
  processedAt: Date;
  amountCents: number;
  /** Pagamento de teste da Shopify. Nunca entra em nenhum total. */
  test: boolean;
};

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

const QUERY = `
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

/**
 * Todas as tender transactions de [from, to], paginando ate o fim.
 *
 * Os limites vao como instantes ISO explicitos e entre aspas, nunca como data
 * nua: e' a diferenca entre pedir um intervalo e torcer para a API adivinhar o
 * fuso. O recorte fino continua sendo responsabilidade de quem chama — a query
 * so precisa nao perder nada.
 */
export async function fetchTenderTransactions(
  storeDomain: string,
  accessToken: string,
  from: Date,
  to: Date
): Promise<TenderTransaction[]> {
  const searchQuery = `processed_at:>='${from.toISOString()}' AND processed_at:<='${to.toISOString()}'`;
  const nodes: TenderTransaction[] = [];
  let after: string | undefined;

  do {
    const data = await shopifyGraphql(storeDomain, accessToken, QUERY, {
      first: PAGE_SIZE,
      after,
      query: searchQuery,
    });
    const connection = data.tenderTransactions;

    for (const edge of connection.edges) {
      const orderId = edge.node.order?.legacyResourceId;
      // Tender sem pedido existe (ajuste manual da loja) e nao ha o que
      // reconciliar contra ele: nenhum pedido nosso reivindica esse dinheiro.
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

/**
 * Janela alargada em um dia para cada lado.
 *
 * Um pedido pode ter uma perna dentro do dia e outra fora (captura Appmax que
 * cai de madrugada). Comparar o pedido pelo TOTAL dele exige enxergar as duas,
 * e um dia de folga cobre com sobra a distancia observada entre pernas.
 */
export function widenedWindowForDay(date: string, timeZone: string): { from: Date; to: Date } {
  return {
    from: dayWindowUtc(addDaysToDayKey(date, -1), timeZone).start,
    to: dayWindowUtc(addDaysToDayKey(date, 1), timeZone).end,
  };
}

/** Pedidos com pelo menos um pagamento real dentro de [start, end). */
export function tenderOrderIdsInWindow(
  tenders: TenderTransaction[],
  start: Date,
  end: Date
): Set<string> {
  const ids = new Set<string>();
  for (const tender of tenders) {
    if (tender.test) continue;
    if (tender.processedAt >= start && tender.processedAt < end) ids.add(tender.orderId);
  }
  return ids;
}

export type TenderTotals = {
  /** orderId -> soma dos pagamentos positivos do pedido. */
  byOrder: Map<string, number>;
  /**
   * Quantas entradas negativas foram descartadas.
   *
   * Nao ha medicao de producao dizendo se a Shopify emite tender negativa para
   * reembolso; a documentacao nao promete nem proibe. Somar so o positivo e' a
   * escolha que mantem a comparacao valida nos dois casos, porque o ledger
   * tambem so soma sale/capture/change e ignora refund
   * (shopify-order-transactions.ts::buildGatewayTotals). Se somassemos o
   * negativo, todo pedido reembolsado viraria divergencia permanente contra um
   * ledger que nunca vai concordar.
   *
   * Este contador existe para a duvida virar medicao: se ele passar de zero em
   * producao, a hipotese esta confirmada e o numero esta no relatorio.
   */
  negativeEntries: number;
};

/**
 * Total por pedido, restrito a `orderIds` quando informado.
 *
 * Sem restricao de janela de proposito: quem chama ja escolheu o conjunto de
 * pedidos, e o que interessa e' o total do PEDIDO. Recortar as pernas por
 * janela aqui transformaria a fresta conhecida do `MAX(processed_at)` por
 * gateway do ledger em falso positivo permanente.
 */
export function tenderTotalsByOrder(
  tenders: TenderTransaction[],
  orderIds?: ReadonlySet<string>
): TenderTotals {
  const byOrder = new Map<string, number>();
  let negativeEntries = 0;

  for (const tender of tenders) {
    if (tender.test) continue;
    if (orderIds && !orderIds.has(tender.orderId)) continue;
    if (tender.amountCents < 0) {
      negativeEntries += 1;
      continue;
    }
    byOrder.set(tender.orderId, (byOrder.get(tender.orderId) ?? 0) + tender.amountCents);
  }

  return { byOrder, negativeEntries };
}

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  retries = 2
): Promise<TenderTransactionsResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/${GRAPHQL_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        // Sempre limitado, nunca em aberto: uma execucao anterior travou ~3 h
        // num fetch sem timeout nenhum.
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
