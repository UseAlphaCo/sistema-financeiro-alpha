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

  const result = await pool.query<UnresolvedShopifyOrder>(
    `
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
      ORDER BY rp.external_order_id DESC
      LIMIT $1
    `,
    values
  );

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
