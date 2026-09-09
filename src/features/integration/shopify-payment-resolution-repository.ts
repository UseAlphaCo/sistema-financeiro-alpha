import { Pool } from "pg";

import { logError } from "@/core/observability/logger";
import { getCoreConnectionString } from "@/shared/read-model-config";

const globalStore = globalThis as typeof globalThis & {
  __shopifyPaymentResolutionPool?: Pool;
};

function getPool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) return null;

  if (!globalStore.__shopifyPaymentResolutionPool) {
    globalStore.__shopifyPaymentResolutionPool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      // Ver comentario equivalente em read-model.ts::getCorePool — sem isso,
      // uma conexao ociosa derrubada pelo pooler do Supabase so e' detectada
      // minutos depois, na proxima tentativa de uso.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      idleTimeoutMillis: 15_000,
    });

    // Sem isto, um ETIMEDOUT numa conexao OCIOSA vira 'error' nao tratado no
    // EventEmitter e derruba o processo inteiro — nao so a query da vez. Foi
    // exatamente o que matou um backfill no meio, depois de ja ter gravado
    // ~900 pedidos. O pg descarta o cliente quebrado sozinho; aqui so
    // registramos para o erro nao ser silencioso.
    globalStore.__shopifyPaymentResolutionPool.on("error", (error) => {
      logError("shopify_payment_resolution_pool_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return globalStore.__shopifyPaymentResolutionPool;
}

/** Fecha o pool. Existe para o teste de integracao nao segurar o processo. */
export async function closeShopifyPaymentResolutionPool(): Promise<void> {
  const pool = globalStore.__shopifyPaymentResolutionPool;
  if (!pool) return;
  globalStore.__shopifyPaymentResolutionPool = undefined;
  await pool.end();
}

export type ShopifyPaymentResolutionRow = {
  external_order_id: string;
  // null = pedido sem nenhuma transacao de pagamento resolvivel (tentado e
  // registrado mesmo assim, para nao reentrar no pool de nao-resolvidos a
  // cada rodada — ver findUnresolvedShopifyOrders). O read-model trata null
  // como "cair na heuristica de payment_gateway_names".
  dominant_gateway_raw: string | null;
  dominant_amount_cents: number;
  total_amount_cents: number;
  transaction_processed_at: string | null;
};

export type UnresolvedShopifyOrder = {
  external_order_id: string;
};

export async function ensureShopifyPaymentResolutionTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.shopify_order_payment_resolution (
      external_order_id text PRIMARY KEY,
      dominant_gateway_raw text NOT NULL,
      dominant_amount_cents bigint NOT NULL,
      total_amount_cents bigint NOT NULL,
      transaction_processed_at timestamptz,
      resolved_at timestamptz NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotente: relaxa a constraint em tabelas ja existentes (criadas antes
  // desta mudanca). Necessario para registrar pedidos sem transacao
  // resolvivel sem usar um valor sentinela — ver runShopifyPaymentResolutionJob.
  await pool.query(`
    ALTER TABLE integration.shopify_order_payment_resolution
    ALTER COLUMN dominant_gateway_raw DROP NOT NULL
  `);
}

/**
 * Pedidos Shopify pagos no mirror que ainda nao tem resolucao de gateway
 * titular, ou cuja resolucao ficou desatualizada (payload do mirror mudou
 * depois da ultima resolucao — ex.: reprocessamento/backfill).
 *
 * Prioriza pedidos mais recentes primeiro (ORDER BY DESC): o backlog
 * historico pode ter dezenas de milhares de pedidos, e o que importa para o
 * Fluxo de Caixa do dia e' resolver rapido os pedidos recentes, nao esvaziar
 * o backlog inteiro numa unica rodada. `sinceReceivedAt` permite escopar a
 * uma janela especifica (ex.: so pedidos dos ultimos N dias) para rodadas
 * curtas e previsiveis.
 */
export async function findUnresolvedShopifyOrders(
  limit: number,
  sinceReceivedAt?: Date
): Promise<UnresolvedShopifyOrder[]> {
  const pool = getPool();
  if (!pool) return [];

  const values: unknown[] = [limit];
  let sinceClause = "";
  if (sinceReceivedAt) {
    values.push(sinceReceivedAt);
    sinceClause = `AND rp.received_at >= $${values.length}`;
  }

  const filtro = `
    SELECT DISTINCT rp.external_order_id
    FROM mirror.raw_payloads rp
    LEFT JOIN integration.shopify_order_payment_resolution spr
      ON spr.external_order_id = rp.external_order_id
    WHERE rp.source = 'shopify'
      AND rp.external_order_id IS NOT NULL
      AND rp.payload_json IS NOT NULL
      AND (
        spr.external_order_id IS NULL
        OR rp.mirror_updated_at > spr.resolved_at
      )
      ${sinceClause}
  `;

  /**
   * Com janela de tempo, forcar a materializacao do filtro ANTES de ordenar.
   *
   * Sem o CTE MATERIALIZED, o `ORDER BY external_order_id DESC LIMIT n` convence
   * o planner a percorrer idx_raw_payloads_external_order_id de tras para
   * frente e filtrar linha a linha, apostando que acha `n` cedo. A aposta so
   * paga quando existe backlog; em regime normal, com a fila quase vazia, ele
   * varre a tabela inteira. Medido em 08/09/2026 com janela de 1 dia:
   * **910.178 linhas descartadas por filtro, 900 mil buffers, 75,7 s** para
   * devolver zero linha — em CADA uma das 12 invocacoes diarias do cron, mesmo
   * sem trabalho nenhum a fazer. Era ~15 min/dia de Fluid Active CPU queimados
   * a toa, na cota que estourou em 25/08/2026.
   *
   * Com o CTE, o filtro passa por idx_raw_payloads_received_at e so depois
   * ordena: **47 ms e 61 mil buffers**, com janela de 3 dias (mais trabalho que
   * a medicao acima). A semantica nao muda — mesmo filtro, mesma prioridade por
   * id decrescente, mesmo limite.
   *
   * Sem janela nao vale a pena: nao ha indice que torne o filtro barato, e ai a
   * parada antecipada do plano antigo e' de fato a melhor aposta. E' o caminho
   * dos scripts manuais de backfill, que e' justamente quando existe backlog.
   */
  const sql = sinceReceivedAt
    ? `WITH candidatos AS MATERIALIZED (${filtro})
       SELECT external_order_id FROM candidatos
       ORDER BY external_order_id DESC
       LIMIT $1`
    : `${filtro} ORDER BY rp.external_order_id DESC LIMIT $1`;

  const result = await pool.query<UnresolvedShopifyOrder>(sql, values);

  return result.rows;
}

export async function upsertShopifyPaymentResolution(row: ShopifyPaymentResolutionRow): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `
      INSERT INTO integration.shopify_order_payment_resolution (
        external_order_id,
        dominant_gateway_raw,
        dominant_amount_cents,
        total_amount_cents,
        transaction_processed_at,
        resolved_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (external_order_id) DO UPDATE SET
        dominant_gateway_raw = EXCLUDED.dominant_gateway_raw,
        dominant_amount_cents = EXCLUDED.dominant_amount_cents,
        total_amount_cents = EXCLUDED.total_amount_cents,
        transaction_processed_at = EXCLUDED.transaction_processed_at,
        resolved_at = NOW()
    `,
    [
      row.external_order_id,
      row.dominant_gateway_raw,
      row.dominant_amount_cents,
      row.total_amount_cents,
      row.transaction_processed_at,
    ]
  );
}

export type ShopifyPaymentGatewaySplitRow = {
  gatewayRaw: string;
  amountCents: number;
  processedAt: string | null;
  transactionCount: number;
};

export async function ensureShopifyPaymentGatewaySplitTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.shopify_order_payment_gateway_split (
      external_order_id text NOT NULL,
      gateway_raw text NOT NULL,
      amount_cents bigint NOT NULL,
      transaction_count integer NOT NULL DEFAULT 0,
      transaction_processed_at timestamptz,
      resolved_at timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (external_order_id, gateway_raw)
    )
  `);

  // Idempotente: tabelas criadas antes da contagem de transacoes existirem.
  await pool.query(`
    ALTER TABLE integration.shopify_order_payment_gateway_split
    ADD COLUMN IF NOT EXISTS transaction_count integer NOT NULL DEFAULT 0
  `);

  // A leitura do Fluxo de Caixa janela por esta coluna (cada perna do pagamento
  // datada pelo seu proprio processed_at, que e como a Shopify monta o
  // relatorio de pagamentos). Sem indice isso vira seq scan da tabela inteira.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shopify_gateway_split_processed_at
    ON integration.shopify_order_payment_gateway_split (transaction_processed_at)
  `);
}

/**
 * Substitui o rateio por gateway de um pedido: apaga o que saiu do conjunto e
 * grava o que entrou, numa unica instrucao.
 *
 * Precisa apagar, e nao so `ON CONFLICT`: um pedido pode trocar de gateway
 * entre resolucoes (ex.: reprocessamento com payload diferente), e o upsert
 * sozinho nunca remove uma linha que deixou de existir. `entries=[]` limpa o
 * rateio inteiro do pedido (pedido sem nenhuma transacao resolvivel).
 *
 * Uma instrucao so, e nao BEGIN/DELETE/INSERT/COMMIT em cliente dedicado: o
 * Postgres ja envolve cada instrucao numa transacao implicita, e as duas
 * pontas do CTE atingem conjuntos disjuntos (`NOT IN` de um lado, `IN` do
 * outro), entao a atomicidade e a mesma. O que muda e o custo: some o
 * `pool.connect()` por pedido e tres round-trips. Desde que TODO pedido
 * resolvido passa por aqui (antes so os com >=2 gateways), segurar um cliente
 * dedicado por pedido esgotava o pool na concorrencia do job e derrubava a
 * rodada com "timeout exceeded when trying to connect".
 */
export async function replaceShopifyPaymentGatewaySplit(
  externalOrderId: string,
  entries: ShopifyPaymentGatewaySplitRow[]
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `
      WITH entradas AS (
        SELECT * FROM UNNEST($2::text[], $3::bigint[], $4::integer[], $5::timestamptz[])
          AS g(gateway_raw, amount_cents, transaction_count, processed_at)
      ),
      removidas AS (
        DELETE FROM integration.shopify_order_payment_gateway_split
        WHERE external_order_id = $1
          AND gateway_raw NOT IN (SELECT gateway_raw FROM entradas)
      )
      INSERT INTO integration.shopify_order_payment_gateway_split
        (external_order_id, gateway_raw, amount_cents, transaction_count, transaction_processed_at, resolved_at)
      SELECT $1, gateway_raw, amount_cents, transaction_count, processed_at, NOW()
      FROM entradas
      ON CONFLICT (external_order_id, gateway_raw) DO UPDATE SET
        amount_cents = EXCLUDED.amount_cents,
        transaction_count = EXCLUDED.transaction_count,
        transaction_processed_at = EXCLUDED.transaction_processed_at,
        resolved_at = NOW()
    `,
    [
      externalOrderId,
      entries.map((entry) => entry.gatewayRaw),
      entries.map((entry) => entry.amountCents),
      entries.map((entry) => entry.transactionCount),
      entries.map((entry) => entry.processedAt),
    ]
  );
}

export type LedgerGatewayTotal = {
  gatewayRaw: string;
  amountCents: number;
  transactionCount: number;
  orderCount: number;
};

export type LedgerDaySummary = {
  grossCents: number;
  transactionCount: number;
  byGateway: LedgerGatewayTotal[];
  /**
   * Pedidos com pelo menos uma perna na janela.
   *
   * Vem como conjunto, e nao como contagem, porque quem compara contra o
   * tenderTransactions precisa saber QUAIS pedidos o tender nao reporta — e' o
   * ponto cego do credito na loja, e ele so e' identificavel por diferenca de
   * conjuntos.
   */
  orderIds: Set<string>;
};

/**
 * O que o ledger de rateio diz que a Shopify processou na janela.
 *
 * Substitui ~1.700 chamadas REST por dia na verificacao diaria. O ledger e' a
 * mesma coisa que aquelas chamadas produziam — foi ele que as gravou —, so que
 * ja persistido: em 08/09/2026 a medicao nao encontrou **nenhuma** divergencia
 * entre `spr.total_amount_cents` e a soma das pernas em 19.237 pedidos. A
 * verificacao contra a Shopify ao vivo continua existindo, mas via
 * tenderTransactions, que custa ~10 chamadas em vez de 1.700.
 *
 * Janela por `transaction_processed_at`, cada perna datada pelo seu proprio
 * pagamento — que e' como a Shopify monta o relatorio de pagamentos brutos.
 * Passa por idx_shopify_gateway_split_processed_at.
 */
export async function getLedgerDaySummary(window: { start: Date; end: Date }): Promise<LedgerDaySummary> {
  const pool = getPool();
  if (!pool) return { grossCents: 0, transactionCount: 0, byGateway: [], orderIds: new Set() };

  const result = await pool.query<{
    external_order_id: string;
    gateway_raw: string;
    amount_cents: string;
    transaction_count: string;
  }>(
    `SELECT external_order_id, gateway_raw, amount_cents::text, transaction_count::text
       FROM integration.shopify_order_payment_gateway_split
      WHERE transaction_processed_at >= $1
        AND transaction_processed_at < $2`,
    [window.start, window.end]
  );

  const porGateway = new Map<string, LedgerGatewayTotal & { orders: Set<string> }>();
  const orderIds = new Set<string>();

  for (const row of result.rows) {
    orderIds.add(row.external_order_id);
    const atual = porGateway.get(row.gateway_raw) ?? {
      gatewayRaw: row.gateway_raw,
      amountCents: 0,
      transactionCount: 0,
      orderCount: 0,
      orders: new Set<string>(),
    };
    atual.amountCents += Number(row.amount_cents);
    atual.transactionCount += Number(row.transaction_count);
    atual.orders.add(row.external_order_id);
    porGateway.set(row.gateway_raw, atual);
  }

  const byGateway = [...porGateway.values()].map(({ orders, ...total }) => ({
    ...total,
    orderCount: orders.size,
  }));

  return {
    grossCents: byGateway.reduce((sum, row) => sum + row.amountCents, 0),
    transactionCount: byGateway.reduce((sum, row) => sum + row.transactionCount, 0),
    byGateway,
    // Nao e' a soma dos orderCount por gateway: um pedido com pagamento
    // dividido entre dois gateways seria contado duas vezes.
    orderIds,
  };
}

/**
 * Rateio do ledger por pedido, quebrado por gateway — sem recorte de janela.
 *
 * Sem recorte de janela de proposito. O ledger guarda uma linha por
 * (pedido, gateway) com um unico `transaction_processed_at`, que e' o MAX das
 * transacoes daquele gateway no pedido. Um pedido com duas capturas do mesmo
 * gateway em dias diferentes tem as duas colapsadas sob a data da ultima.
 * Comparar por janela transformaria essa fresta conhecida em divergencia
 * permanente, e o detector nunca convergiria. Comparado por PEDIDO, o total
 * fecha.
 *
 * Quebrado por gateway, e nao somado, porque quem compara contra a Shopify
 * precisa descartar as pernas de credito na loja — a Shopify nao emite tender
 * transaction para elas. Somar aqui obrigaria o consumidor a subtrair depois
 * sem saber o que subtrair.
 */
export async function findLedgerGatewayTotalsByOrderIds(
  orderIds: string[]
): Promise<Map<string, Map<string, number>>> {
  const pool = getPool();
  if (!pool || orderIds.length === 0) return new Map();

  const result = await pool.query<{ external_order_id: string; gateway_raw: string; amount_cents: string }>(
    `SELECT external_order_id, gateway_raw, sum(amount_cents)::text AS amount_cents
       FROM integration.shopify_order_payment_gateway_split
      WHERE external_order_id = ANY($1::text[])
      GROUP BY external_order_id, gateway_raw`,
    [orderIds]
  );

  const porPedido = new Map<string, Map<string, number>>();
  for (const row of result.rows) {
    const gateways = porPedido.get(row.external_order_id) ?? new Map<string, number>();
    gateways.set(row.gateway_raw, Number(row.amount_cents));
    porPedido.set(row.external_order_id, gateways);
  }

  return porPedido;
}

/** Pulso do ledger de rateio e estado do pipeline por dia, para o painel. */
export type PipelineStatus = {
  /** Ultima perna gravada no ledger. null = o ledger nunca escreveu nada. */
  lastLedgerWriteAt: string | null;
  /** Pagamento mais recente ja presente no ledger. */
  lastPaymentProcessedAt: string | null;
  days: PipelineDay[];
};

export type PipelineDay = {
  day: string;
  orders: number;
  /** Quando este dia foi materializado pela ultima vez. */
  lastMaterializedAt: string | null;
  /** Pedidos sem nenhuma perna no ledger de rateio. */
  withoutLedger: number;
  /** Pedidos que o job de resolucao ainda nao visitou. */
  withoutResolution: number;
};

/**
 * Estado da reconciliacao por dia, ancorado em integration.financial_orders.
 *
 * Ancorar na materializada, e nao no mirror, e' deliberado: a mesma pergunta
 * feita sobre mirror.raw_payloads exige DISTINCT ON sobre uma tabela de 2754 MB
 * e levou 38 s numa medicao de 08/09/2026 — inviavel num render de tela, e
 * exatamente o tipo de leitura cara que estourou a cota de CPU da Vercel.
 *
 * A consequencia e' que este numero mede "do que o sistema ja materializou,
 * quanto falta reconciliar". Pedido pago que ainda nao foi materializado nao
 * aparece aqui — quem responde por ele e' o bloco de materializacao do painel.
 * Cada bloco mede a sua propria camada, e nenhum finge medir a do outro.
 *
 * Os dois NOT EXISTS usam a PK de cada tabela auxiliar, entao sao sondagens de
 * indice: ~1.000 pedidos/dia na janela padrao.
 */
export async function getPipelineStatus(days = 7): Promise<PipelineStatus | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const pulse = await pool.query<{ last_write: Date | null; last_payment: Date | null }>(`
      SELECT max(resolved_at) AS last_write,
             max(transaction_processed_at) AS last_payment
        FROM integration.shopify_order_payment_gateway_split
    `);

    const perDay = await pool.query<{
      day: string;
      orders: string;
      last_materialized_at: Date | null;
      without_ledger: string;
      without_resolution: string;
    }>(
      `
      SELECT to_char(date(fo.occurred_at AT TIME ZONE 'America/Bahia'), 'YYYY-MM-DD') AS day,
             count(*)::text AS orders,
             max(fo.materialized_at) AS last_materialized_at,
             count(*) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM integration.shopify_order_payment_gateway_split s
                  WHERE s.external_order_id = fo.order_key
               )
             )::text AS without_ledger,
             count(*) FILTER (
               WHERE NOT EXISTS (
                 SELECT 1 FROM integration.shopify_order_payment_resolution r
                  WHERE r.external_order_id = fo.order_key
               )
             )::text AS without_resolution
        FROM integration.financial_orders fo
       WHERE fo.source_key = 'shopify'
         AND fo.occurred_at >= now() - make_interval(days => $1::int)
       GROUP BY 1
       ORDER BY 1 DESC
      `,
      [days]
    );

    return {
      lastLedgerWriteAt: pulse.rows[0]?.last_write?.toISOString() ?? null,
      lastPaymentProcessedAt: pulse.rows[0]?.last_payment?.toISOString() ?? null,
      days: perDay.rows.map((row) => ({
        day: row.day,
        orders: Number(row.orders),
        lastMaterializedAt: row.last_materialized_at?.toISOString() ?? null,
        withoutLedger: Number(row.without_ledger),
        withoutResolution: Number(row.without_resolution),
      })),
    };
  } catch (error) {
    // Tabela ausente neste ambiente e' falta de dado, nao falha da tela. O
    // painel distingue null de zero: null vira "sem dado", nunca "tudo certo".
    logError("pipeline_status_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
