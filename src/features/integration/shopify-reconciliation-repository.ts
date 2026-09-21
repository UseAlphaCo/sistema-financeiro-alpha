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
  /**
   * Tentativas de conserto gastas no ciclo atual.
   *
   * Nao e' o mesmo que `occurrences`: aquele conta quantas vezes o pedido foi
   * DETECTADO divergindo, este conta quantas vezes alguem tentou consertar.
   * Um pedido pode ser detectado tres dias seguidos e ter uma unica tentativa,
   * se o teto da rodada o adiou nas outras duas.
   */
  attempts: number;
  detectedAt: string;
  lastCheckedAt: string;
  /**
   * Quando a linha volta a ser elegivel para tentativa.
   *
   * `null` significa "elegivel agora" (nunca foi agendada), e nao "fora da
   * fila" — quem tira da fila e' o status ou o teto de tentativas, nunca este
   * campo. Manter um unico significado aqui evita o bug classico de um NULL que
   * ora quer dizer "ja" ora quer dizer "nunca".
   */
  nextAttemptAt: string | null;
  correctedAt: string | null;
};

/**
 * Status que significam "ainda aberto" e, portanto, elegiveis a retentativa.
 *
 * Lista explicita, e nao `status <> 'corrigido'`, de proposito: S3 e S5 vao
 * acrescentar estados de FECHAMENTO (reconferido, aceito por gente). Com a
 * negacao, cada estado novo entraria na fila por omissao e o sistema voltaria a
 * bater na Shopify por pedido que alguem ja deu por encerrado.
 */
const STATUS_EM_ABERTO: ReconciliationStatus[] = ["pendente", "persistente", "sem_correcao"];

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
      attempts            integer     NOT NULL DEFAULT 0,
      detected_at         timestamptz NOT NULL DEFAULT NOW(),
      last_checked_at     timestamptz NOT NULL DEFAULT NOW(),
      next_attempt_at     timestamptz,
      corrected_at        timestamptz
    )
  `);

  // Aditivo para quem ja tem a tabela: o CREATE acima so vale em base nova, e o
  // deploy nao roda `migrate deploy`. `ADD COLUMN IF NOT EXISTS` e' no-op quando
  // a coluna existe, entao os dois caminhos convergem para o mesmo schema.
  await pool.query(`
    ALTER TABLE integration.shopify_reconciliation_divergences
      ADD COLUMN IF NOT EXISTS attempts        integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz
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
 *
 * `attempts` segue a mesma logica, e por isso zera SO na transicao para
 * `persistente`: ali houve evidencia nova de verdade — o pedido chegou a fechar
 * e reabriu, entao o orcamento de tentativas recomeca. Uma redeteccao de quem
 * nunca fechou nao e' evidencia nova, e zerar ali faria o pedido sem conserto
 * ser retentado para sempre, todo dia, gastando o teto da rodada e uma chamada
 * a Admin API sem nunca escalar para gente.
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
        attempts = CASE
          WHEN integration.shopify_reconciliation_divergences.status = 'corrigido'
            THEN 0
          ELSE integration.shopify_reconciliation_divergences.attempts
        END,
        next_attempt_at = CASE
          WHEN integration.shopify_reconciliation_divergences.status = 'corrigido'
            THEN NULL
          ELSE integration.shopify_reconciliation_divergences.next_attempt_at
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
 *
 * `attempts` sobe SEMPRE, porque chegar aqui ja significa ter gasto uma chamada
 * a Admin API. `nextAttemptAt` omitido (o default) quer dizer "nao reagende" —
 * o caso de quem fechou ou de quem esgotou o orcamento e agora espera gente.
 */
export async function markDivergenceOutcome(
  externalOrderId: string,
  status: ReconciliationStatus,
  ledgerCentsAfter: number,
  nextAttemptAt: Date | null = null
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `
      UPDATE integration.shopify_reconciliation_divergences
         SET status             = $2,
             ledger_cents_after = $3,
             corrected_at       = CASE WHEN $2 = 'corrigido' THEN NOW() ELSE corrected_at END,
             attempts           = attempts + 1,
             next_attempt_at    = $4,
             last_checked_at    = NOW()
       WHERE external_order_id = $1
    `,
    [externalOrderId, status, ledgerCentsAfter, nextAttemptAt]
  );
}

/**
 * Contabiliza uma tentativa que nao chegou a produzir veredito.
 *
 * Existe porque a tentativa que EXPLODE (rede, 429, Admin API fora) tambem
 * custou uma chamada e tambem precisa recuar. Sem isto, o pedido que falha por
 * um motivo permanente ficaria elegivel em toda rodada, gastando o teto e a
 * cota da Shopify indefinidamente, e nunca escalaria para gente — que e'
 * exatamente a cegueira que esta fase existe para fechar.
 *
 * Nunca escreve `ledger_cents_after`: nao houve medicao, e inventar veredito a
 * partir de uma falha de transporte seria afirmar sobre o ledger uma coisa que
 * ninguem verificou. `status` so muda quando quem chamou passa um — o caso de
 * quem esgotou as tentativas falhando, que precisa sair de `pendente` para nao
 * ficar parecendo fila no painel quando ninguem mais vai busca-lo.
 */
export async function markDivergenceAttemptFailed(
  externalOrderId: string,
  options: { nextAttemptAt: Date | null; status?: ReconciliationStatus }
): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(
    `
      UPDATE integration.shopify_reconciliation_divergences
         SET attempts        = attempts + 1,
             next_attempt_at = $2,
             status          = COALESCE($3, status),
             last_checked_at = NOW()
       WHERE external_order_id = $1
    `,
    [externalOrderId, options.nextAttemptAt, options.status ?? null]
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

type DivergenceDbRow = {
  external_order_id: string;
  day: Date;
  tender_cents: string;
  ledger_cents_before: string;
  delta_cents: string;
  ledger_cents_after: string | null;
  status: string;
  occurrences: number;
  attempts: number;
  detected_at: Date;
  last_checked_at: Date;
  next_attempt_at: Date | null;
  corrected_at: Date | null;
};

const COLUNAS_DIVERGENCIA = `
  external_order_id, day, tender_cents, ledger_cents_before, delta_cents,
  ledger_cents_after, status, occurrences, attempts, detected_at,
  last_checked_at, next_attempt_at, corrected_at
`;

function mapDivergenceRow(row: DivergenceDbRow): ReconciliationDivergenceRow {
  return {
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
    attempts: row.attempts,
    detectedAt: row.detected_at.toISOString(),
    lastCheckedAt: row.last_checked_at.toISOString(),
    nextAttemptAt: row.next_attempt_at?.toISOString() ?? null,
    correctedAt: row.corrected_at?.toISOString() ?? null,
  };
}

/** Divergencias para inspecao, mais recentes primeiro. Usado pelo CLI. */
export async function listDivergences(
  options: { status?: ReconciliationStatus; limit?: number } = {}
): Promise<ReconciliationDivergenceRow[]> {
  const pool = getPool();
  if (!pool) return [];

  const limit = options.limit ?? 100;
  const result = await pool.query<DivergenceDbRow>(
    `
      SELECT ${COLUNAS_DIVERGENCIA}
        FROM integration.shopify_reconciliation_divergences
       WHERE ($1::text IS NULL OR status = $1)
       ORDER BY day DESC, abs(delta_cents) DESC
       LIMIT $2
    `,
    [options.status ?? null, limit]
  );

  return result.rows.map(mapDivergenceRow);
}

export type RetryableDivergences = {
  /** Ate `limit` linhas, maior dinheiro primeiro. */
  rows: ReconciliationDivergenceRow[];
  /**
   * Quantas linhas estavam elegiveis ANTES do teto.
   *
   * Vem junto de proposito: sem este numero, `rows.length === limit` nao
   * distingue "a fila tem exatamente o teto" de "a fila transbordou", e o
   * painel nao teria como dizer honestamente quanto ficou para a proxima
   * rodada. Sai da mesma query por window function, entao nao custa ida extra.
   */
  eligible: number;
};

/**
 * A fila de tratamento: o que ainda esta aberto e ja pode ser tentado de novo.
 *
 * Este e' o consumidor que a tabela nunca teve. Antes disto `runShopifyReconciliation`
 * so ESCREVIA divergencia: uma linha cuja correcao falhou, ou que o teto da
 * rodada adiou, saia da janela D-1..D-3 e nunca mais era olhada por ninguem.
 *
 * Tres condicoes, cada uma tirando um tipo de linha da fila:
 *
 * - `status` em aberto      -> nao retenta o que ja fechou
 * - `attempts < maxAttempts`-> nao insiste no que ja provou nao ceder; a linha
 *   fica em `sem_correcao`, que o painel mostra em vermelho, esperando gente
 * - `next_attempt_at`       -> respeita o recuo; `NULL` e' "nunca agendada",
 *   logo elegivel agora
 *
 * A ordem por `|delta_cents|` decrescente e' a mesma da varredura da janela:
 * quando o teto corta, o que fica para depois e' sempre o menor dinheiro.
 */
export async function listRetryableDivergences(options: {
  limit: number;
  maxAttempts: number;
}): Promise<RetryableDivergences> {
  const pool = getPool();
  if (!pool) return { rows: [], eligible: 0 };

  const result = await pool.query<DivergenceDbRow & { elegiveis: string }>(
    `
      SELECT ${COLUNAS_DIVERGENCIA}, (count(*) OVER ())::text AS elegiveis
        FROM integration.shopify_reconciliation_divergences
       WHERE status = ANY($1::text[])
         AND attempts < $2
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
       ORDER BY abs(delta_cents) DESC
       LIMIT $3
    `,
    [STATUS_EM_ABERTO, options.maxAttempts, options.limit]
  );

  return {
    rows: result.rows.map(mapDivergenceRow),
    // `count(*) OVER ()` e' avaliado antes do LIMIT, entao conta a fila inteira.
    eligible: result.rows.length === 0 ? 0 : Number(result.rows[0].elegiveis),
  };
}

function formatDateOnly(value: Date): string {
  const ano = value.getFullYear();
  const mes = String(value.getMonth() + 1).padStart(2, "0");
  const dia = String(value.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}
