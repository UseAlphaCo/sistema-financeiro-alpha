import { Pool } from "pg";

import { queryWithTimeout } from "@/core/db/pg-session";
import { logWarn } from "@/core/observability/logger";
import type {
  MaterializedOrder,
  MaterializedOrderKey,
} from "@/features/transactions/read-model-filters";
import { getCoreConnectionString } from "@/shared/read-model-config";

/**
 * Persistencia de integration.financial_orders -- uma linha por PEDIDO, com o
 * dedup de eventos ja resolvido na escrita.
 *
 * O mirror guarda uma linha por EVENTO. A diferenca entre as duas coisas e o
 * que obriga hoje cada request a trazer a janela inteira de eventos para a
 * memoria do Node e dedupar ali. Materializar move esse trabalho para uma
 * execucao diaria.
 *
 * `ensureFinancialOrdersTable()` e a fonte de verdade do DDL, e nao uma
 * migration: `vercel.json` roda apenas `prisma generate && next build`, ou seja
 * nao existe `prisma migrate deploy` no pipeline. scripts/sql/financial-orders.sql
 * e a copia legivel do mesmo DDL. Mesmo padrao de
 * shopify-payment-resolution-repository.ts.
 */

const globalStore = globalThis as typeof globalThis & {
  __financialOrdersPool?: Pool;
};

function getPool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) return null;

  if (!globalStore.__financialOrdersPool) {
    globalStore.__financialOrdersPool = new Pool({
      connectionString,
      max: 2,
      connectionTimeoutMillis: 10_000,
      // Maior que os 20 s do read model de proposito: aqui quem chama e o job,
      // que grava lotes de mil linhas, nao um request de usuario.
      statement_timeout: 120_000,
      // Ver comentario equivalente em mirror-events-repository.ts::getCorePool.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      idleTimeoutMillis: 15_000,
    });

    // O statement_timeout do construtor nao chega ao servidor (o Supavisor
    // descarta o startup packet). Quem o aplica e queryWithTimeout.
  }

  return globalStore.__financialOrdersPool;
}

// Os tipos vivem em read-model-filters.ts (modulo folha) porque quem os produz
// e o mapeador puro, que nao pode depender deste modulo -- que importa `pg`.
// Reexportados aqui por conveniencia de quem so lida com persistencia.
export type { MaterializedOrder, MaterializedOrderKey };

/**
 * Colunas do UPSERT, em ordem. Lista unica para o INSERT, para os
 * placeholders e para a montagem dos valores -- tres listas paralelas
 * divergiriam, e o sintoma seria valor gravado na coluna errada, nao erro.
 */
const UPSERT_COLUMNS = [
  "source",
  "order_key",
  "mirror_row_id",
  "external_id",
  "occurred_at",
  "marketplace",
  "marketplace_key",
  "source_key",
  "source_bucket",
  "order_number",
  "description",
  "payment_method_raw",
  "payment_method_normalized",
  "amount_cents",
  "shipping_cents",
  "discount_cents",
  "tax_cents",
  "fee_cents",
  "liquid_cents",
  "currency",
  "type",
  "tx_source",
  "status",
  "received_at",
  "source_updated_at",
  "search_text",
  "content_hash",
] as const;

/**
 * Linhas por comando de UPSERT.
 *
 * O protocolo do Postgres limita 65.535 parametros ligados por consulta, e sao
 * 27 colunas por linha -- o teto absoluto e 2.427. Fica em 1.000 por folga
 * deliberada: acrescentar uma coluna no futuro nao pode aproximar o lote do
 * teto em silencio. (Os 5.000 de scripts/backfill-mirror-window.ts, que grava
 * 10 colunas, estourariam aqui.)
 *
 * O gargalo desta materializacao e a LEITURA do mirror -- payload_json de 10 a
 * 30 KB por evento --, nao a escrita, entao subir este numero nao compra tempo.
 */
export const UPSERT_BATCH_ROWS = 1_000;

/**
 * Limite das operacoes desta tabela. Maior que os 20 s do caminho de request de
 * proposito: quem chama e o job, gravando lotes de mil linhas. Aplicado por SET
 * -- ver src/core/db/pg-session.ts.
 */
const WRITE_TIMEOUT_MS = 120_000;

function toValues(order: MaterializedOrder): unknown[] {
  return [
    order.source,
    order.orderKey,
    order.mirrorRowId,
    order.externalId,
    order.occurredAt,
    order.marketplace,
    order.marketplaceKey,
    order.sourceKey,
    order.sourceBucket,
    order.orderNumber,
    order.description,
    order.paymentMethodRaw,
    order.paymentMethodNormalized,
    order.amountCents,
    order.shippingCents,
    order.discountCents,
    order.taxCents,
    order.feeCents,
    order.liquidCents,
    order.currency,
    order.type,
    order.txSource,
    order.status,
    order.receivedAt,
    order.sourceUpdatedAt,
    order.searchText,
    order.contentHash,
  ];
}

export async function ensureFinancialOrdersTable(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS integration.financial_orders (
      source                    text        NOT NULL,
      order_key                 text        NOT NULL,
      mirror_row_id             uuid,
      external_id               text,
      occurred_at               timestamptz NOT NULL,
      marketplace               text,
      marketplace_key           text,
      source_key                text,
      source_bucket             text,
      order_number              text,
      description               text,
      payment_method_raw        text,
      payment_method_normalized text,
      amount_cents              bigint      NOT NULL,
      shipping_cents            bigint      NOT NULL DEFAULT 0,
      discount_cents            bigint      NOT NULL DEFAULT 0,
      tax_cents                 bigint      NOT NULL DEFAULT 0,
      fee_cents                 bigint      NOT NULL DEFAULT 0,
      liquid_cents              bigint      NOT NULL DEFAULT 0,
      currency                  text        NOT NULL DEFAULT 'BRL',
      type                      text        NOT NULL,
      tx_source                 text        NOT NULL,
      status                    text        NOT NULL,
      received_at               timestamptz,
      source_updated_at         timestamptz,
      search_text               text,
      content_hash              text        NOT NULL,
      materialized_at           timestamptz NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, order_key)
    )
  `);

  // Ordem da listagem inclui a PK inteira: occurred_at empata aos milhares
  // (pedidos no mesmo segundo) e OFFSET sobre ordem instavel repete ou pula
  // linha entre paginas.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_financial_orders_occurred_at
      ON integration.financial_orders (occurred_at DESC, source, order_key)
  `);

  // Dois indices, nao um: o filtro de marketplace casa contra marketplace_key
  // OU source_key.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_financial_orders_marketplace_key
      ON integration.financial_orders (marketplace_key, occurred_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_financial_orders_source_key
      ON integration.financial_orders (source_key, occurred_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_financial_orders_payment_method
      ON integration.financial_orders (payment_method_normalized, occurred_at DESC)
  `);

  // Nenhum CONCURRENTLY: a tabela nasce vazia neste mesmo comando, entao nao ha
  // escrita concorrente para bloquear nem custo de construcao. (CONCURRENTLY
  // continua obrigatorio para indice em mirror.raw_payloads, que tem dado --
  // mas medido em 2026-08-21 nenhum indice novo e necessario lá; ver
  // scripts/sql/financial-orders.sql.)
  await ensureSearchTextIndex(pool);
}

/**
 * Indice de busca textual, com degradacao explicita.
 *
 * Trigram e nao tsvector: tsvector tokeniza por palavra e mudaria o
 * comportamento observavel -- "1234" deixaria de achar "#12345", que e como as
 * pessoas buscam pedido.
 *
 * Tres tentativas porque no Supabase a extensao vive no schema `extensions`,
 * que nao esta no search_path da conexao da aplicacao: sem qualificar, o
 * opclass `gin_trgm_ops` nao resolve mesmo com a extensao instalada. Se nada
 * funcionar, a busca continua correta pelo LIKE sobre o subconjunto ja
 * recortado por data -- mais lenta, nao errada. E por isso que a busca nunca
 * deve ser servida sem range de data.
 */
async function ensureSearchTextIndex(pool: Pool): Promise<void> {
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions`);
  } catch (error) {
    logWarn("financial_orders_pg_trgm_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const attempts = [
    `CREATE INDEX IF NOT EXISTS idx_financial_orders_search_text
       ON integration.financial_orders USING gin (search_text extensions.gin_trgm_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_financial_orders_search_text
       ON integration.financial_orders USING gin (search_text gin_trgm_ops)`,
  ];

  for (const sql of attempts) {
    try {
      await pool.query(sql);
      return;
    } catch {
      // Tenta a proxima forma; o aviso final e emitido abaixo.
    }
  }

  logWarn("financial_orders_search_index_missing", {
    consequencia: "busca textual cai em LIKE sem indice; exigir range de data",
  });
}

/**
 * Grava um lote de pedidos.
 *
 * O guard `WHERE content_hash IS DISTINCT FROM EXCLUDED.content_hash` evita
 * UPDATE no-op: sem ele, rodar o job duas vezes reescreveria todas as linhas,
 * gerando tupla morta e perdendo a atualizacao HOT. Devolve quantas linhas
 * mudaram de fato -- numero que so tem significado por causa do guard.
 */
export async function upsertFinancialOrders(orders: MaterializedOrder[]): Promise<number> {
  if (orders.length === 0) return 0;

  const pool = getPool();
  if (!pool) return 0;

  let changed = 0;

  for (let start = 0; start < orders.length; start += UPSERT_BATCH_ROWS) {
    const batch = orders.slice(start, start + UPSERT_BATCH_ROWS);
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const order of batch) {
      const rowValues = toValues(order);
      const placeholders = rowValues.map((_, index) => `$${values.length + index + 1}`);
      tuples.push(`(${placeholders.join(", ")})`);
      values.push(...rowValues);
    }

    const updates = UPSERT_COLUMNS.filter(
      (column) => column !== "source" && column !== "order_key"
    ).map((column) => `${column} = EXCLUDED.${column}`);

    const result = await pool.query(
      `
        INSERT INTO integration.financial_orders (${UPSERT_COLUMNS.join(", ")})
        VALUES ${tuples.join(", ")}
        ON CONFLICT (source, order_key) DO UPDATE
          SET ${updates.join(", ")},
              materialized_at = NOW()
          WHERE integration.financial_orders.content_hash IS DISTINCT FROM EXCLUDED.content_hash
      `,
      values
    );

    changed += result.rowCount ?? 0;
  }

  return changed;
}

/**
 * Apaga pedidos que deixaram de produzir linha valida (estorno, cancelamento,
 * pedido que caiu de "pago" para outro status).
 *
 * Sem este passo, pedido estornado soma para sempre: o UPSERT nunca visitaria a
 * chave de novo, porque ela nao aparece mais no conjunto mapeado.
 */
export async function deleteFinancialOrders(keys: MaterializedOrderKey[]): Promise<number> {
  if (keys.length === 0) return 0;

  const pool = getPool();
  if (!pool) return 0;

  // Dois arrays paralelos em vez de uma lista de tuplas: mantem o numero de
  // parametros em 2, independente da quantidade de chaves.
  const result = await pool.query(
    `
      DELETE FROM integration.financial_orders fo
      USING unnest($1::text[], $2::text[]) AS k(source, order_key)
      WHERE fo.source = k.source AND fo.order_key = k.order_key
    `,
    [keys.map((k) => k.source), keys.map((k) => k.orderKey)]
  );

  return result.rowCount ?? 0;
}

/**
 * Defasagem da materializacao, para a tela /integracoes.
 *
 * Rodar so uma vez por dia significa que as telas refletem o dado da ultima
 * execucao. Isso e aceitavel, mas nao pode ser silencioso -- daí expor a idade
 * do dado em vez de deixar quem olha supor que e de agora.
 */
export async function getMaterializedLag(): Promise<{
  maxMaterializedAt: string | null;
  maxOccurredAt: string | null;
  total: number;
} | null> {
  const pool = getPool();
  if (!pool) return null;

  try {
    const result = await pool.query<{
      max_materialized_at: Date | null;
      max_occurred_at: Date | null;
      total: string;
    }>(
      `
        SELECT max(materialized_at) AS max_materialized_at,
               max(occurred_at)     AS max_occurred_at,
               count(*)::text       AS total
        FROM integration.financial_orders
      `
    );

    const row = result.rows[0];
    return {
      maxMaterializedAt: row?.max_materialized_at?.toISOString() ?? null,
      maxOccurredAt: row?.max_occurred_at?.toISOString() ?? null,
      // count(*) volta como bigint, e bigint chega como string no driver `pg`.
      total: Number(row?.total ?? 0),
    };
  } catch (error) {
    // Tabela ainda nao existe neste ambiente: e ausencia de dado, nao falha da
    // tela que so quer mostrar a defasagem.
    const code = (error as { code?: string }).code;
    if (code === "42P01") return null;
    throw error;
  }
}

/**
 * Escapa um termo de busca para `LIKE ... ESCAPE '\'`.
 *
 * Existe porque o caminho legado usa String.includes, onde `%` e `_` sao
 * caracteres COMUNS. Sem escapar, buscar "50%" viraria "qualquer coisa que
 * comece com 50" no SQL e devolveria um conjunto diferente do que a tela
 * devolve hoje -- divergencia silenciosa entre os dois caminhos, que e
 * exatamente o que esta migracao nao pode introduzir.
 *
 * A barra vem primeiro: escapar `%` antes de `\` faria o proprio escape ser
 * escapado depois.
 */
export function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export type ListMaterializedFilters = {
  /**
   * Pagina e limite. `limit: null` traz TUDO que casa, sem LIMIT/OFFSET -- e o
   * que a agregacao (fluxo de caixa) precisa, e continua sendo ordens de
   * magnitude mais barato que o caminho atual: 26 colunas pequenas por PEDIDO
   * em vez de payload_json de 10 a 30 KB por EVENTO.
   */
  page?: number;
  limit?: number | null;
  type?: string;
  status?: string;
  source?: string;
  sources?: string[];
  marketplace?: string;
  paymentMethod?: string;
  categoryId?: string;
  /** Datas ja recortadas no piso de cobertura pelo chamador. */
  startDate?: Date | null;
  endDate?: Date | null;
  /** Termo ja normalizado (minusculo, sem espaco nas pontas). */
  search?: string;
};

export type FinancialOrderRow = {
  source: string;
  order_key: string;
  mirror_row_id: string | null;
  external_id: string | null;
  occurred_at: Date;
  marketplace: string | null;
  marketplace_key: string | null;
  source_key: string | null;
  source_bucket: string | null;
  order_number: string | null;
  description: string | null;
  payment_method_raw: string | null;
  payment_method_normalized: string | null;
  amount_cents: number;
  shipping_cents: number;
  discount_cents: number;
  tax_cents: number;
  fee_cents: number;
  liquid_cents: number;
  currency: string;
  type: string;
  tx_source: string;
  status: string;
  received_at: Date | null;
  source_updated_at: Date | null;
  total_count: number;
};

/**
 * Listagem paginada de pedidos materializados.
 *
 * Diferenca central em relacao ao caminho atual: WHERE, ORDER BY, LIMIT e
 * OFFSET sao do BANCO. Hoje a paginacao acontece em memoria depois de trazer a
 * janela inteira, com payload_json de 10 a 30 KB por evento.
 *
 * A ordem inclui a chave primaria inteira (occurred_at DESC, source, order_key)
 * porque occurred_at empata aos milhares, e OFFSET sobre ordem instavel repete
 * ou pula linha entre paginas.
 *
 * `count(*) OVER ()` traz o total na mesma varredura, com `::int` para nao voltar
 * como string (o driver `pg` entrega bigint como string) -- o mapeador ainda
 * aplica Number() por cima, porque `::int` protege a query e Number() protege
 * quem consome.
 */
export async function listMaterializedOrders(
  filters: ListMaterializedFilters
): Promise<{ rows: FinancialOrderRow[]; total: number }> {
  const pool = getPool();
  if (!pool) return { rows: [], total: 0 };

  // Pedido materializado tem categoryId sempre null (invariante do mapeamento),
  // entao qualquer filtro por categoria elimina o conjunto todo -- sem abrir
  // consulta. Espelha mirrorCannotContribute do caminho legado.
  if (filters.categoryId) return { rows: [], total: 0 };

  const conditions: string[] = [];
  const values: unknown[] = [];

  const push = (sql: (placeholder: string) => string, value: unknown) => {
    values.push(value);
    conditions.push(sql(`$${values.length}`));
  };

  if (filters.type) push((p) => `fo.type = ${p}`, filters.type);
  // status NAO e filtrado por omissao: linhas 'rejected' somam hoje, e excluir
  // aqui mudaria os totais das telas.
  if (filters.status) push((p) => `fo.status = ${p}`, filters.status);
  if (filters.source) push((p) => `fo.tx_source = ${p}`, filters.source);
  if (filters.sources && filters.sources.length > 0) {
    push((p) => `fo.tx_source = ANY(${p}::text[])`, filters.sources);
  }
  // Marketplace casa contra marketplace_key OU source_key -- as duas colunas
  // existem por isso. Comparar so uma perderia metade dos pedidos.
  if (filters.marketplace) {
    push((p) => `(fo.marketplace_key = ${p} OR fo.source_key = ${p})`, filters.marketplace);
  }
  // Igualdade exata, nao ILIKE: para linha do mirror classifyPaymentMethod
  // sempre devolve um PaymentMethod valido, entao o fallback textual do caminho
  // legado nunca dispara.
  if (filters.paymentMethod) {
    push((p) => `fo.payment_method_normalized = ${p}`, filters.paymentMethod);
  }
  if (filters.startDate) push((p) => `fo.occurred_at >= ${p}`, filters.startDate);
  if (filters.endDate) push((p) => `fo.occurred_at <= ${p}`, filters.endDate);
  if (filters.search) {
    push((p) => `fo.search_text LIKE ${p} ESCAPE '\\'`, `%${escapeLikeTerm(filters.search)}%`);
  }

  const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let paginationSql = "";
  if (typeof filters.limit === "number") {
    const offset = Math.max(((filters.page ?? 1) - 1) * filters.limit, 0);
    values.push(filters.limit);
    const limitPlaceholder = `$${values.length}`;
    values.push(offset);
    const offsetPlaceholder = `$${values.length}`;
    paginationSql = `LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`;
  }

  const result = await queryWithTimeout<FinancialOrderRow>(
    pool,
    WRITE_TIMEOUT_MS,
    `
      SELECT fo.source, fo.order_key, fo.mirror_row_id, fo.external_id, fo.occurred_at,
             fo.marketplace, fo.marketplace_key, fo.source_key, fo.source_bucket,
             fo.order_number, fo.description, fo.payment_method_raw,
             fo.payment_method_normalized,
             fo.amount_cents::int   AS amount_cents,
             fo.shipping_cents::int AS shipping_cents,
             fo.discount_cents::int AS discount_cents,
             fo.tax_cents::int      AS tax_cents,
             fo.fee_cents::int      AS fee_cents,
             fo.liquid_cents::int   AS liquid_cents,
             fo.currency, fo.type, fo.tx_source, fo.status,
             fo.received_at, fo.source_updated_at,
             count(*) OVER ()::int  AS total_count
      FROM integration.financial_orders fo
      ${whereSql}
      ORDER BY fo.occurred_at DESC, fo.source, fo.order_key
      ${paginationSql}
    `,
    values
  );

  // Sem linhas, count(*) OVER () nao produz linha nenhuma -- o total tem de vir
  // de zero, e nao de undefined virando NaN adiante.
  const total = result.rows.length > 0 ? Number(result.rows[0].total_count) : 0;

  return { rows: result.rows, total };
}

export async function closePool(): Promise<void> {
  if (globalStore.__financialOrdersPool) {
    await globalStore.__financialOrdersPool.end();
    globalStore.__financialOrdersPool = undefined;
  }
}
