import { Pool } from "pg";

import { logError } from "@/core/observability/logger";
import { getCoreConnectionString } from "@/shared/read-model-config";

/**
 * Persistencia das divergencias por pedido entre o ledger de rateio e a Shopify.
 *
 * Ver scripts/sql/shopify-reconciliation-divergences.sql para o porque da tabela
 * e das escolhas de grao, status e retencao. Aqui fica a fonte de verdade do DDL
 * (ensureShopifyReconciliationTable), porque o deploy roda so
 * `prisma generate && next build` e nao aplica migration no schema `integration`.
 */

const globalStore = globalThis as typeof globalThis & {
  __shopifyReconciliationPool?: Pool;
};

function getPool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) return null;

  if (!globalStore.__shopifyReconciliationPool) {
    globalStore.__shopifyReconciliationPool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      // Mesmo motivo do pool de resolucao: sem keepAlive uma conexao ociosa
      // derrubada pelo pooler do Supabase so e' detectada minutos depois, ja
      // dentro da proxima invocacao do cron.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      idleTimeoutMillis: 15_000,
    });

    // Sem isto, um ETIMEDOUT numa conexao OCIOSA vira 'error' nao tratado no
    // EventEmitter e derruba o processo inteiro, nao so a query da vez.
    globalStore.__shopifyReconciliationPool.on("error", (error) => {
      logError("shopify_reconciliation_pool_error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return globalStore.__shopifyReconciliationPool;
}

/** Fecha o pool. Existe para o teste de integracao nao segurar o processo. */
export async function closeShopifyReconciliationPool(): Promise<void> {
  const pool = globalStore.__shopifyReconciliationPool;
  if (!pool) return;
  globalStore.__shopifyReconciliationPool = undefined;
  await pool.end();
}

export type ReconciliationStatus =
  /** Detectado e ainda nao corrigido (fila, teto da rodada, ou correcao falhou). */
  | "pendente"
  /** Re-resolvido e o ledger passou a bater com a Shopify. */
  | "corrigido"
  /** Ja esteve corrigido e voltou a divergir. Candidato a defeito estrutural. */
  | "persistente"
  /** Re-resolvido, mas o ledger continua discordando. Precisa de gente. */
  | "sem_correcao";

export type ReconciliationDivergenceRow = {
  externalOrderId: string;
  day: string;
  tenderCents: number;
  ledgerCentsBefore: number;
  deltaCents: number;
  ledgerCentsAfter: number | null;
  status: ReconciliationStatus;
  occurrences: number;
  detectedAt: string;
  lastCheckedAt: string;
  correctedAt: string | null;
};

export async function ensureShopifyReconciliationTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.shopify_reconciliation_divergences (
      external_order_id   text PRIMARY KEY,
      day                 date        NOT NULL,
      tender_cents        bigint      NOT NULL,
      ledger_cents_before bigint      NOT NULL,
      delta_cents         bigint      NOT NULL,
      ledger_cents_after  bigint,
      status              text        NOT NULL,
      occurrences         integer     NOT NULL DEFAULT 1,
      detected_at         timestamptz NOT NULL DEFAULT NOW(),
      last_checked_at     timestamptz NOT NULL DEFAULT NOW(),
      corrected_at        timestamptz
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_shopify_reconciliation_status_day
    ON integration.shopify_reconciliation_divergences (status, day DESC)
  `);
}

export type DetectedDivergence = {
  externalOrderId: string;
  day: string;
  tenderCents: number;
  ledgerCents: number;
  deltaCents: number;
};

/**
 * Registra a deteccao, preservando a historia do pedido.
 *
 * O `ON CONFLICT` nao e' um upsert qualquer — ele decide o status a partir do
 * que a linha ja dizia, e essa decisao e' a razao de a tabela existir:
 *
 * - linha nova            -> `pendente`
 * - ja estava `corrigido` -> **`persistente`**: foi consertado e voltou a
 *   divergir, o que e' um sinal categoricamente diferente de "atrasou de novo"
 * - qualquer outro estado -> segue `pendente`
 *
 * `detected_at` nunca e' reescrito (e a primeira vez que o pedido apareceu);
 * `occurrences` soma; `ledger_cents_after` e `corrected_at` sao zerados, porque
 * uma correcao anterior deixou de valer no instante em que o pedido divergiu de
 * novo. Sem esse reset, um pedido persistente exibiria o "depois" de um conserto
 * que a realidade ja desmentiu.
 */
export async function recordDetectedDivergences(items: DetectedDivergence[]): Promise<number> {
  const pool = getPool();
  if (!pool || items.length === 0) return 0;

  const result = await pool.query(
    `
      INSERT INTO integration.shopify_reconciliation_divergences (
        external_order_id, day, tender_cents, ledger_cents_before, delta_cents, status
      )
      SELECT * FROM UNNEST(
        $1::text[], $2::date[], $3::bigint[], $4::bigint[], $5::bigint[], $6::text[]
      )
      ON CONFLICT (external_order_id) DO UPDATE SET
        day                 = EXCLUDED.day,
        tender_cents        = EXCLUDED.tender_cents,
        ledger_cents_before = EXCLUDED.ledger_cents_before,
        delta_cents         = EXCLUDED.delta_cents,
        ledger_cents_after  = NULL,
        corrected_at        = NULL,
        status = CASE
          WHEN integration.shopify_reconciliation_divergences.status = 'corrigido'
            THEN 'persistente'
          ELSE 'pendente'
        END,
        occurrences     = integration.shopify_reconciliation_divergences.occurrences + 1,
        last_checked_at = NOW()
    `,
    [
      items.map((item) => item.externalOrderId),
      items.map((item) => item.day),
      items.map((item) => item.tenderCents),
      items.map((item) => item.ledgerCents),
      items.map((item) => item.deltaCents),
      items.map(() => "pendente"),
    ]
  );

  return result.rowCount ?? 0;
}

/**
 * Fecha (ou nao) uma divergencia depois da tentativa de re-resolucao.
 *
 * `status` vem decidido por quem chamou, que e' quem sabe se o ledger passou a
 * bater. `corrected_at` so e' gravado quando fechou de fato — um pedido em
 * `sem_correcao` foi tocado, nao consertado, e datar isso como correcao faria o
 * relatorio mentir.
 */
export async function markDivergenceOutcome(
  externalOrderId: string,
  status: ReconciliationStatus,
  ledgerCentsAfter: number
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `
      UPDATE integration.shopify_reconciliation_divergences
         SET status             = $2,
             ledger_cents_after = $3,
             corrected_at       = CASE WHEN $2 = 'corrigido' THEN NOW() ELSE corrected_at END,
             last_checked_at    = NOW()
       WHERE external_order_id = $1
    `,
    [externalOrderId, status, ledgerCentsAfter]
  );
}

/** Contagem por status, para o resumo da rodada e o painel. */
export async function countDivergencesByStatus(): Promise<Record<ReconciliationStatus, number>> {
  const zerado: Record<ReconciliationStatus, number> = {
    pendente: 0,
    corrigido: 0,
    persistente: 0,
    sem_correcao: 0,
  };

  const pool = getPool();
  if (!pool) return zerado;

  const result = await pool.query<{ status: string; total: string }>(
    `SELECT status, count(*)::text AS total
       FROM integration.shopify_reconciliation_divergences
      GROUP BY status`
  );

  for (const row of result.rows) {
    if (row.status in zerado) {
      zerado[row.status as ReconciliationStatus] = Number(row.total);
    }
  }

  return zerado;
}

/** Divergencias para inspecao, mais recentes primeiro. Usado pelo CLI. */
export async function listDivergences(
  options: { status?: ReconciliationStatus; limit?: number } = {}
): Promise<ReconciliationDivergenceRow[]> {
  const pool = getPool();
  if (!pool) return [];

  const limit = options.limit ?? 100;
  const result = await pool.query<{
    external_order_id: string;
    day: Date;
    tender_cents: string;
    ledger_cents_before: string;
    delta_cents: string;
    ledger_cents_after: string | null;
    status: string;
    occurrences: number;
    detected_at: Date;
    last_checked_at: Date;
    corrected_at: Date | null;
  }>(
    `
      SELECT external_order_id, day, tender_cents, ledger_cents_before, delta_cents,
             ledger_cents_after, status, occurrences, detected_at, last_checked_at, corrected_at
        FROM integration.shopify_reconciliation_divergences
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY day DESC, abs(delta_cents) DESC
       LIMIT $2
    `,
    [options.status ?? null, limit]
  );

  return result.rows.map((row) => ({
    externalOrderId: row.external_order_id,
    // `day` e' DATE: o driver devolve Date a meia-noite LOCAL do processo, entao
    // toISOString() pode voltar um dia. Formatar pelos componentes locais e' o
    // unico jeito de devolver a data que esta gravada.
    day: formatDateOnly(row.day),
    tenderCents: Number(row.tender_cents),
    ledgerCentsBefore: Number(row.ledger_cents_before),
    deltaCents: Number(row.delta_cents),
    ledgerCentsAfter: row.ledger_cents_after === null ? null : Number(row.ledger_cents_after),
    status: row.status as ReconciliationStatus,
    occurrences: row.occurrences,
    detectedAt: row.detected_at.toISOString(),
    lastCheckedAt: row.last_checked_at.toISOString(),
    correctedAt: row.corrected_at?.toISOString() ?? null,
  }));
}

function formatDateOnly(value: Date): string {
  const ano = value.getFullYear();
  const mes = String(value.getMonth() + 1).padStart(2, "0");
  const dia = String(value.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}
