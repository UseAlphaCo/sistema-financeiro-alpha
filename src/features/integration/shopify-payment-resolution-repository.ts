import { Pool } from "pg";

import { getCoreConnectionString } from "@/shared/read-model-config";

const globalStore = globalThis as typeof globalThis & {
  __shopifyPaymentResolutionPool?: Pool;
};

function getPool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) return null;

  if (!globalStore.__shopifyPaymentResolutionPool) {
    globalStore.__shopifyPaymentResolutionPool = new Pool({ connectionString, max: 2 });
  }

  return globalStore.__shopifyPaymentResolutionPool;
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
 */
export async function findUnresolvedShopifyOrders(limit: number): Promise<UnresolvedShopifyOrder[]> {
  const pool = getPool();
  if (!pool) return [];

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
      ORDER BY rp.external_order_id
      LIMIT $1
    `,
    [limit]
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
