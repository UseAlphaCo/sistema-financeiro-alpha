import { logInfo, logWarn } from "@/core/observability/logger";
import {
  deleteFinancialOrders,
  ensureFinancialOrdersTable,
  upsertFinancialOrders,
} from "@/features/transactions/financial-orders-repository";
import {
  findCandidateOrderKeys,
  findMirrorRowsByOrderKeys,
} from "@/features/transactions/mirror-events-repository";
import { toMaterializedOrder } from "@/features/transactions/mirror-order-mapper";
import type { MaterializedOrder, MaterializedOrderKey } from "@/features/transactions/read-model-filters";

/**
 * MATERIALIZACAO DE PEDIDOS
 * =========================
 *
 * Move para uma execucao diaria o trabalho que hoje cada request faz: ler a
 * janela inteira de eventos do mirror, dedupar em memoria e mapear para pedido.
 *
 * Cinco passos por janela de dia:
 *   1. chaves candidatas por received_at (com folga de 2 dias de cada lado);
 *   2. TODOS os eventos dessas chaves, dedupados (o dedup precisa do conjunto
 *      completo do pedido, e nao so do que caiu na janela);
 *   3. mapear com toMaterializedOrder -- a MESMA funcao do caminho de request;
 *   4. UPSERT com guard de content_hash;
 *   5. DELETE das chaves que nao produziram mais linha valida.
 *
 * O passo 5 e o que impede pedido estornado de somar para sempre: quando o
 * pedido deixa de ser "pago", o mapeamento devolve null e a chave nunca mais
 * apareceria num UPSERT -- a linha velha ficaria la, correta no passado e errada
 * no presente.
 *
 * Idempotente por construcao: rodar duas vezes e no-op, porque o guard de hash
 * transforma o segundo UPSERT em zero linhas alteradas.
 */

/**
 * Folga de descoberta em cada lado da janela.
 *
 * Um evento que chega hoje pode pertencer a um pedido de anteontem (reentrega de
 * webhook, backfill, resolucao tardia de gateway). Sem a folga, o pedido antigo
 * nunca seria revisitado e a materializacao congelaria a primeira versao dele.
 */
const DISCOVERY_GRACE_DAYS = 2;

/**
 * Chaves por lote de leitura do mirror.
 *
 * Medido: 500 chaves -> ~2.500 eventos em ~131 ms. O custo dominante e
 * payload_json (10 a 30 KB por evento), entao lote grande nao acelera -- so
 * transforma uma consulta em transferencia de centenas de MB, com mais chance de
 * o pooler derrubar a conexao no meio.
 */
const KEY_CHUNK = 500;

export type MaterializeDayResult = {
  /** Dia processado, em YYYY-MM-DD (fuso America/Sao_Paulo). */
  day: string;
  candidateKeys: number;
  events: number;
  mapped: number;
  /** Linhas efetivamente alteradas -- o guard de hash exclui as no-op. */
  written: number;
  deleted: number;
  durationMs: number;
};

/**
 * Limites de um dia de calendario em America/Sao_Paulo, ja com a folga.
 *
 * Fuso no literal e nao na sessao: o pooler (Supavisor) descarta PGTZ, entao
 * qualquer coisa que dependa da timezone da conexao e' irreproduzivel. O offset
 * -03:00 e fixo no Brasil desde 2019 (nao ha mais horario de verao).
 */
function resolveDayWindow(day: string): { from: Date; to: Date } {
  const start = new Date(`${day}T00:00:00-03:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`dia invalido: ${day} (esperado YYYY-MM-DD)`);
  }

  const graceMs = DISCOVERY_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    from: new Date(start.getTime() - graceMs),
    to: new Date(end.getTime() + graceMs),
  };
}

function keyOf(item: MaterializedOrderKey): string {
  return `${item.source}\u001f${item.orderKey}`;
}

/** Materializa um dia. Ver o docblock do modulo para os cinco passos. */
export async function materializeOrdersForDay(day: string): Promise<MaterializeDayResult> {
  const startedAt = Date.now();
  const { from, to } = resolveDayWindow(day);

  await ensureFinancialOrdersTable();

  const candidates = await findCandidateOrderKeys(from, to);

  let events = 0;
  let mapped = 0;
  let written = 0;
  const produced = new Set<string>();

  for (let start = 0; start < candidates.length; start += KEY_CHUNK) {
    const chunk = candidates.slice(start, start + KEY_CHUNK);
    const rows = await findMirrorRowsByOrderKeys(chunk);
    events += rows.length;

    const orders: MaterializedOrder[] = [];
    for (const row of rows) {
      const order = toMaterializedOrder(row);
      if (!order) continue;
      orders.push(order);
      produced.add(keyOf(order));
    }

    mapped += orders.length;
    written += await upsertFinancialOrders(orders);

    logInfo("materialize_orders_chunk", {
      day,
      fromKey: start,
      keys: chunk.length,
      events: rows.length,
      mapped: orders.length,
    });
  }

  // Passo 5. So chaves DESTE conjunto candidato entram no DELETE -- nunca um
  // "apague tudo que nao esta no resultado", que apagaria a tabela inteira
  // sempre que a janela fosse pequena.
  const toDelete = candidates
    .map((candidate) => ({ source: candidate.source, orderKey: candidate.orderKey }))
    .filter((candidate) => !produced.has(keyOf(candidate)));

  const deleted = await deleteFinancialOrders(toDelete);

  const result: MaterializeDayResult = {
    day,
    candidateKeys: candidates.length,
    events,
    mapped,
    written,
    deleted,
    durationMs: Date.now() - startedAt,
  };

  logInfo("materialize_orders_day", result);

  // Candidato que nao produziu pedido e o caso NORMAL (nao pago, valor zero,
  // sem data) -- mas uma proporcao muito alta significa outra coisa, e o
  // silencio aqui esconderia uma regressao no mapeamento.
  if (candidates.length > 0 && mapped === 0) {
    logWarn("materialize_orders_day_empty", {
      day,
      candidateKeys: candidates.length,
      events,
    });
  }

  return result;
}

/** Dia de calendario em America/Sao_Paulo, com deslocamento em dias. */
export function saoPauloDay(reference: Date, offsetDays = 0): string {
  const shifted = new Date(reference.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  // sv-SE devolve YYYY-MM-DD, que e exatamente o formato do parametro.
  return shifted.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

export type MaterializeJobResult = {
  mode: "day";
  days: MaterializeDayResult[];
};

export type MaterializeJobOptions = {
  /**
   * Dias explicitos (YYYY-MM-DD). Sem isto, roda D-1 e D-2.
   *
   * D-2 nao e redundancia: captura o que mudou depois do fechamento do dia --
   * reembolso, cancelamento, resolucao tardia de gateway titular.
   */
  days?: string[];
  reference?: Date;
};

/**
 * O job. Nasce parametrizado por modo -- hoje so "day" -- para que aumentar a
 * frequencia depois (modo incremental por watermark) seja configuracao e nao
 * reescrita.
 *
 * Sequencial de proposito: cada dia le o mirror pesado, e dois dias em paralelo
 * competiriam pelas 2 conexoes do pool contra o mesmo pooler que ja derrubou
 * conexao nesta investigacao.
 */
export async function runMaterializeOrdersJob(
  options: MaterializeJobOptions = {}
): Promise<MaterializeJobResult> {
  const reference = options.reference ?? new Date();
  const days = options.days ?? [saoPauloDay(reference, -1), saoPauloDay(reference, -2)];

  const results: MaterializeDayResult[] = [];
  for (const day of days) {
    results.push(await materializeOrdersForDay(day));
  }

  return { mode: "day", days: results };
}
