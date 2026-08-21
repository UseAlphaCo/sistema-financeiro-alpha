import { Pool } from "pg";

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
  }

  return corePool;
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
        pool.query<MirrorRow>(buildMirrorQuery(MIRROR_ROW_COLUMNS, MIRROR_ROW_JOIN, whereSql, tailSql), values)
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
    pool.query<MirrorRow>(buildMirrorQuery(MIRROR_ROW_COLUMNS_FALLBACK, MIRROR_ROW_JOIN_FALLBACK, whereSql, tailSql), values)
  );
  return { rows: dedupeMirrorRows(result.rows) };
}
