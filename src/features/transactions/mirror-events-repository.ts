import { Pool } from "pg";

import { queryWithTimeout } from "@/core/db/pg-session";
import { dedupeMirrorRows } from "@/features/transactions/mirror-order-mapper";
import type { MirrorRow } from "@/features/transactions/read-model-filters";
import { getCoreConnectionString } from "@/shared/read-model-config";

/**
 * Acesso ao mirror no CORE: pool, retry de conexao e a consulta de eventos com
 * a resolucao de gateway anexada.
 *
 * Separado do mapeador de proposito — aqui vive tudo que depende de `pg`, e o
 * mapeador fica testavel sem banco. A dedup e chamada daqui porque o contrato
 * desta camada e "uma linha por pedido", nao "uma linha por evento": quem
 * consome nao deveria ter de saber que o mirror guarda evento.
 */

const MIRROR_ROW_COLUMNS = `
  rp.id, rp.source, rp.event_type, rp.external_order_id, rp.payload_json,
  rp.received_at, rp.mirror_updated_at, rp.processing_status,
  spr.dominant_gateway_raw AS resolved_gateway_raw,
  spr.transaction_processed_at AS resolved_transaction_processed_at
`;

const MIRROR_ROW_JOIN = `
  FROM mirror.raw_payloads rp
  LEFT JOIN integration.shopify_order_payment_resolution spr
    ON spr.external_order_id = rp.external_order_id AND rp.source = 'shopify'
`;

// Fallback usado quando integration.shopify_order_payment_resolution ainda
// nao existe no banco (job de resolucao nunca rodou nesse ambiente/ainda nao
// processou nenhum pedido) — evita que a pagina de transacoes/fluxo de caixa
// quebre por completo por causa de uma tabela auxiliar ausente; cai na
// heuristica de payment_gateway_names ate a tabela existir.
const MIRROR_ROW_COLUMNS_FALLBACK = `
  rp.id, rp.source, rp.event_type, rp.external_order_id, rp.payload_json,
  rp.received_at, rp.mirror_updated_at, rp.processing_status,
  NULL::text AS resolved_gateway_raw,
  NULL::timestamptz AS resolved_transaction_processed_at
`;

const MIRROR_ROW_JOIN_FALLBACK = `FROM mirror.raw_payloads rp`;

/** Limite do caminho de request. Aplicado por SET, nao pelo construtor do Pool. */
const READ_TIMEOUT_MS = 20_000;

/**
 * Limite da descoberta de candidatos da materializacao: e um scan de indice
 * sobre a janela inteira, medido em 4,1 s para 5 dias, e roda fora de request.
 */
const DISCOVERY_TIMEOUT_MS = 120_000;

let resolutionTableKnownMissing = false;

function isMissingResolutionTableError(error: unknown): boolean {
  const pgError = error as { code?: string; message?: string };
  return (
    pgError?.code === "42P01" &&
    typeof pgError.message === "string" &&
    pgError.message.includes("shopify_order_payment_resolution")
  );
}

function buildMirrorQuery(columns: string, join: string, whereSql: string, tailSql: string): string {
  return `
    SELECT ${columns}
    ${join}
    WHERE ${whereSql}
    ${tailSql}
  `;
}

// Quedas de conexao (nao erros de SQL) observadas de forma intermitente
// contra o CORE_DB_URL, mesmo com uma unica query sequencial — instabilidade
// de rede/pooler fora do nosso controle. Um retry curto absorve o blip sem
// propagar erro pro usuario final; se persistir apos as tentativas, o erro
// original sobe normalmente.
function isTransientConnectionError(error: unknown): boolean {
  const err = error as { message?: string; code?: string } | null;
  if (!err) return false;
  if (typeof err.message === "string" && err.message.includes("Connection terminated unexpectedly")) {
    return true;
  }
  // Estouro do connectionTimeoutMillis ao ADQUIRIR conexao no pool -- mensagem
  // diferente da anterior e sem `code`. Aparece quando o link esta saturado:
  // observado em 2026-08-22 matando uma materializacao de 2 h no 11o lote,
  // porque nao era reconhecido aqui e portanto nao era retentado.
  if (typeof err.message === "string" && err.message.includes("Connection terminated due to connection timeout")) {
    return true;
  }
  // 57014 (statement timeout) tambem entra aqui: numa conexao recem-aberta
  // (ex.: primeira consulta apos o processo subir), a mesma query que roda
  // em ~300ms isolada as vezes estoura o statement_timeout so por causa da
  // lentidao de handshake da rede local ate o Supabase — nao pelo custo real
  // da query (confirmado via EXPLAIN ANALYZE). Retry curto tende a pegar uma
  // conexao ja estabelecida e resolver.
  return ["ECONNRESET", "ETIMEDOUT", "08006", "08003", "08001", "57014"].includes(err.code ?? "");
}

export async function withConnectionRetry<T>(run: () => Promise<T>, retries = 2): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientConnectionError(error) || attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

let corePool: Pool | null = null;

export function getCorePool(): Pool | null {
  const connectionString = getCoreConnectionString();
  if (!connectionString) {
    return null;
  }

  if (!corePool) {
    corePool = new Pool({
      connectionString,
      application_name: "sistema-financeiro-read-model",
      max: 2,
      // Falhar rapido em vez de ficar pendurado indefinidamente quando a
      // rede/banco fica instavel (ja observado nesta investigacao).
      connectionTimeoutMillis: 10_000,
      statement_timeout: 20_000,
      // Defesa contra pooler (Supavisor) derrubando conexoes ociosas do lado
      // do servidor sem avisar o cliente — sem TCP keepalive, o driver so
      // percebe na proxima tentativa de uso, e fica pendurado esperando
      // resposta de um socket morto. idleTimeoutMillis reduz a chance de a
      // conexao ficar ociosa tempo suficiente pro pooler mata-la primeiro.
      // NOTA: a lentidao de minutos observada em teste local (26/07) teve
      // causa DIFERENTE — confirmada via pg_stat_activity como wait_event
      // ClientWrite, ou seja, o Postgres ja tinha o resultado pronto e
      // estava so tentando transmitir o payload_json inteiro (JSON bruto do
      // pedido, ~10-30KB por linha) pela rede local ate o Supabase (us-east-1).
      // Nao e' bug de conexao/query; e' volume de dados x banda da rede local
      // de dev. Reduzir os bytes trafegados (projetar so os campos usados do
      // JSON via SQL em vez de "payload_json" inteiro) resolveria de raiz, mas
      // e' uma reescrita maior, nao feita nesta rodada.
      keepAlive: true,
      keepAliveInitialDelayMillis: 5_000,
      idleTimeoutMillis: 15_000,
    });

    // O `statement_timeout` acima NAO CHEGA AO SERVIDOR -- o Supavisor descarta
    // parametros de startup. Quem o aplica de verdade e queryWithTimeout, com
    // SET explicito na conexao. Ver src/core/db/pg-session.ts.
  }

  return corePool;
}

/**
 * Chave candidata a materializar. `isExternal` distingue as duas formas de
 * order_key -- external_order_id ou o proprio id -- porque cada uma tem seu
 * indice: `rp.id::text = ANY(...)` desperdicaria a PK ao forcar cast.
 */
export type CandidateOrderKey = {
  source: string;
  orderKey: string;
  isExternal: boolean;
};

/**
 * Passo 1 da materializacao: quais pedidos tiveram evento na janela.
 *
 * Recorta por `received_at` (nao por occurred_at) porque e a coluna indexada e a
 * unica que o mirror controla. O chamador ja aplica folga de dias de cada lado:
 * um evento que chega hoje pode pertencer a um pedido de anteontem.
 *
 * Medido em 2026-08-21 contra 810.637 linhas: Index Scan em
 * idx_raw_payloads_received_at, 63.359 linhas -> 29.108 chaves em 4,1 s. Nao
 * traz payload_json, entao nao toca o TOAST.
 */
export async function findCandidateOrderKeys(
  fromReceivedAt: Date,
  toReceivedAt: Date
): Promise<CandidateOrderKey[]> {
  const pool = getCorePool();
  if (!pool) return [];

  const result = await withConnectionRetry(() =>
    queryWithTimeout<{ source: string; order_key: string; is_external: boolean }>(
      pool,
      DISCOVERY_TIMEOUT_MS,
      `
        SELECT DISTINCT
               rp.source,
               COALESCE(rp.external_order_id, rp.id::text) AS order_key,
               (rp.external_order_id IS NOT NULL)          AS is_external
        FROM mirror.raw_payloads rp
        WHERE rp.received_at >= $1
          AND rp.received_at <  $2
          AND rp.payload_json IS NOT NULL
          AND rp.source IN ('shopify', 'anymarket')
      `,
      [fromReceivedAt, toReceivedAt]
    )
  );

  return result.rows.map((row) => ({
    source: row.source,
    orderKey: row.order_key,
    isExternal: row.is_external,
  }));
}

/**
 * Passo 1b: pedidos cuja resolucao de gateway chegou DEPOIS de terem sido
 * materializados.
 *
 * Existe porque a descoberta do passo 1 recorta so por `received_at`, e gravar
 * em `shopify_order_payment_resolution` nao altera coluna nenhuma de
 * `mirror.raw_payloads`. Do ponto de vista do passo 1, um pedido que acabou de
 * ter o gateway resolvido e indistinguivel de um que nao mudou.
 *
 * O problema disso: para pedido Shopify, `occurred_at` prefere
 * `transaction_processed_at` -- a data real do pagamento -- e so cai no
 * `processed_at` do pedido enquanto a resolucao nao chega. O cron diario cobre
 * D-0..D-2 com folga de +-2, ou seja `received_at` de D-4 a D+2; resolucao que
 * chega depois disso NUNCA era aplicada e o `occurred_at` ficava congelado no
 * fallback para sempre. Medido em 2026-08-25: 65% dos pedidos materializados do
 * dia ja discordavam da resolucao que existia para eles.
 *
 * O criterio e `resolved_at > materialized_at`, e nao uma janela de tempo: e
 * exatamente o conjunto defasado, ele se esvazia sozinho conforme e processado,
 * e nao depende de adivinhar quanto tempo a resolucao pode atrasar.
 *
 * O `LIMIT` existe para o cron diario nao tentar engolir um backlog inteiro
 * numa invocacao. Backlog grande converge em algumas rodadas -- ou de uma vez
 * por scripts/materialize-orders-window.ts, que e o caminho para carga historica.
 *
 * O join usa `fo.order_key`, nao `fo.external_id`: order_key e a PK
 * (source, order_key), e para Shopify vale COALESCE(external_order_id, id), que
 * e o external_order_id sempre que existe resolucao.
 */
export async function findOrderKeysWithStaleResolution(
  limite: number
): Promise<CandidateOrderKey[]> {
  const pool = getCorePool();
  if (!pool) return [];

  const result = await withConnectionRetry(() =>
    queryWithTimeout<{ source: string; order_key: string }>(
      pool,
      DISCOVERY_TIMEOUT_MS,
      `
        SELECT fo.source, fo.order_key
        FROM integration.shopify_order_payment_resolution res
        JOIN integration.financial_orders fo
          ON fo.source = 'shopify'
         AND fo.order_key = res.external_order_id
        WHERE res.transaction_processed_at IS NOT NULL
          AND res.resolved_at > fo.materialized_at
        ORDER BY res.resolved_at
        LIMIT $1
      `,
      [limite]
    )
  );

  return result.rows.map((row) => ({
    source: row.source,
    orderKey: row.order_key,
    isExternal: true,
  }));
}

/**
 * Passo 2: TODOS os eventos das chaves dadas, ja dedupados para um por pedido.
 *
 * Busca por chave e nao por data de proposito -- o dedup precisa do conjunto
 * completo do pedido, e um evento antigo do mesmo pedido pode estar fora da
 * janela. E por isso que o passo 1 existe separado.
 *
 * Chame em lotes: 500 chaves rendem ~2.500 eventos em ~131 ms (medido), e cada
 * evento carrega payload_json de 10 a 30 KB. Lote grande nao acelera nada e
 * transforma a consulta em transferencia de centenas de MB.
 */
export async function findMirrorRowsByOrderKeys(keys: CandidateOrderKey[]): Promise<MirrorRow[]> {
  if (keys.length === 0) return [];

  const pool = getCorePool();
  if (!pool) return [];

  const externalIds = keys.filter((key) => key.isExternal).map((key) => key.orderKey);
  const rowIds = keys.filter((key) => !key.isExternal).map((key) => key.orderKey);

  const result = await queryMirrorRows(
    pool,
    [externalIds, rowIds],
    `(rp.external_order_id = ANY($1::text[]) OR rp.id = ANY($2::uuid[]))
       AND rp.payload_json IS NOT NULL
       AND rp.source IN ('shopify', 'anymarket')`
  );

  return result.rows;
}

export async function queryMirrorRows(
  pool: Pool,
  values: unknown[],
  whereSql: string,
  tailSql = ""
): Promise<{ rows: MirrorRow[] }> {
  if (!resolutionTableKnownMissing) {
    try {
      const result = await withConnectionRetry(() =>
        queryWithTimeout<MirrorRow>(
          pool,
          READ_TIMEOUT_MS,
          buildMirrorQuery(MIRROR_ROW_COLUMNS, MIRROR_ROW_JOIN, whereSql, tailSql),
          values
        )
      );
      return { rows: dedupeMirrorRows(result.rows) };
    } catch (error) {
      if (!isMissingResolutionTableError(error)) {
        throw error;
      }
      resolutionTableKnownMissing = true;
    }
  }

  const result = await withConnectionRetry(() =>
    queryWithTimeout<MirrorRow>(
      pool,
      READ_TIMEOUT_MS,
      buildMirrorQuery(MIRROR_ROW_COLUMNS_FALLBACK, MIRROR_ROW_JOIN_FALLBACK, whereSql, tailSql),
      values
    )
  );
  return { rows: dedupeMirrorRows(result.rows) };
}
