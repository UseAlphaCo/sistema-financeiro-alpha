import { logError, logInfo, logWarn } from "@/core/observability/logger";
import {
  deleteFinancialOrders,
  ensureFinancialOrdersTable,
  upsertFinancialOrders,
} from "@/features/transactions/financial-orders-repository";
import {
  findCandidateOrderKeys,
  findMirrorRowsByOrderKeys,
  findOrderKeysWithStaleResolution,
} from "@/features/transactions/mirror-events-repository";
import {
  describeMaterializationRejection,
  toMaterializedOrder,
  type MaterializationRejection,
} from "@/features/transactions/mirror-order-mapper";
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
 * O gargalo NAO e o banco. Medido em 2026-08-22 contra producao: 500 chaves
 * rendem ~1.423 eventos (2,85 por pedido), o servidor resolve em 2,7 ms com
 * BitmapOr sobre os dois indices existentes, e o lote leva ~20 s ponta a ponta.
 * A diferenca inteira e transferencia: payload_json tem 6.960 bytes de media
 * (maximo 22 kB), entao o lote traz ~10 MB e o `pg_stat_activity` mostra a
 * conexao em Client/ClientRead -- o servidor terminou e espera o cliente ler.
 *
 * Consequencia pratica: aumentar o lote nao compra tempo (a banda e a mesma) e
 * aumenta a janela em que uma queda do pooler custa mais trabalho refeito.
 * Rodando dentro da Vercel, na mesma regiao do banco, este custo cai de forma
 * que nao vale otimizar aqui.
 */
const KEY_CHUNK = 500;

/**
 * Teto de chaves trazidas por resolucao tardia numa invocacao.
 *
 * Existe para o cron diario nao tentar engolir um backlog historico inteiro e
 * estourar o maxDuration de 300 s. 5.000 chaves sao 10 lotes de KEY_CHUNK,
 * somados aos ~15 mil da janela do dia (medido em producao: 58 s) -- cabe com
 * folga, e backlog maior converge em algumas rodadas.
 *
 * Para carga historica de uma vez, o caminho e
 * scripts/materialize-orders-window.ts, que nao tem limite de plataforma.
 */
const LATE_RESOLUTION_LIMIT = 5_000;

export type MaterializeDayResult = {
  /** Dia processado, em YYYY-MM-DD (fuso America/Sao_Paulo). */
  day: string;
  candidateKeys: number;
  /**
   * Pedidos distintos lidos do mirror -- NAO eventos.
   * findMirrorRowsByOrderKeys ja devolve dedupado (uma linha por pedido), entao
   * a contagem de eventos crus nao passa por aqui. Medido em 2026-08-22: cada
   * pedido tem ~2,85 eventos, e sao esses eventos que pagam a transferencia.
   */
  dedupedOrders: number;
  mapped: number;
  /**
   * Por que os candidatos que NAO viraram pedido nao viraram.
   *
   * Sem isto, "103.834 chaves geraram 91.640 pedidos" nao distingue pedido nao
   * pago (esperado) de regressao no mapeamento (grave).
   */
  rejections: Record<MaterializationRejection, number>;
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
  const { from, to } = resolveDayWindow(day);
  return materializeWindow(day, from, to);
}

/**
 * Materializa um INTERVALO numa unica passada.
 *
 * Existe porque a folga de descoberta faz cada invocacao por dia processar 5
 * dias: rodar 22 dias um a um le ~110 dias-equivalentes de evento, 5x de
 * trabalho redundante. Medido em 2026-08-22, um unico dia levou mais de 10
 * minutos -- o mes inteiro assim passaria de 4 horas.
 *
 * A folga esta CERTA para o job diario, onde ela captura o evento que chegou
 * atrasado. Esta errada para carga inicial, onde o intervalo ja e largo. Aqui a
 * folga e aplicada uma vez, nas duas pontas do intervalo, e nao por dia.
 *
 * O resultado e identico ao de rodar dia a dia -- os mesmos cinco passos sobre a
 * uniao dos mesmos candidatos.
 */
export async function materializeOrdersForRange(
  startDay: string,
  endDay: string,
  resumeFromKey = 0
): Promise<MaterializeDayResult> {
  const inicio = resolveDayWindow(startDay);
  const fim = resolveDayWindow(endDay);

  if (fim.to < inicio.from) {
    throw new Error(`intervalo invertido: ${startDay} a ${endDay}`);
  }

  return materializeWindow(`${startDay}..${endDay}`, inicio.from, fim.to, resumeFromKey);
}

/**
 * Tentativas por lote antes de desistir.
 *
 * Existe porque uma carga inicial leva horas contra um link domestico, e uma
 * queda de conexao no meio nao pode custar a corrida inteira -- foi o que
 * aconteceu em 2026-08-22, no 11o lote. Cada lote e independente (le por chave,
 * grava por UPSERT idempotente), entao repetir e sempre seguro.
 */
const CHUNK_ATTEMPTS = 4;

async function comRetentativa<T>(rotulo: string, run: () => Promise<T>): Promise<T> {
  for (let tentativa = 1; ; tentativa++) {
    try {
      return await run();
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      if (tentativa >= CHUNK_ATTEMPTS) {
        logError("materialize_orders_chunk_failed", { rotulo, tentativa, error: mensagem });
        throw error;
      }

      // Espera crescente: se o link esta saturado, tentar de novo na hora so
      // reproduz a falha.
      const esperaMs = 2_000 * tentativa;
      logWarn("materialize_orders_chunk_retry", { rotulo, tentativa, esperaMs, error: mensagem });
      await new Promise((resolve) => setTimeout(resolve, esperaMs));
    }
  }
}

async function materializeWindow(
  rotulo: string,
  from: Date,
  to: Date,
  resumeFromKey = 0
): Promise<MaterializeDayResult> {
  const startedAt = Date.now();
  const day = rotulo;

  await ensureFinancialOrdersTable();

  const daJanela = await comRetentativa("candidatos", () => findCandidateOrderKeys(from, to));

  // Pedidos cuja resolucao de gateway chegou depois da materializacao. Nao sao
  // alcancaveis pelo recorte por `received_at` -- ver o docblock de
  // findOrderKeysWithStaleResolution. Sem isto, resolucao tardia corrige o
  // read-model ao vivo e deixa `occurred_at` errado na tabela para sempre.
  const porResolucaoTardia = await comRetentativa("resolucao_tardia", () =>
    findOrderKeysWithStaleResolution(LATE_RESOLUTION_LIMIT)
  );

  const vistas = new Set(daJanela.map((c) => `${c.source}|${c.orderKey}`));
  const extras = porResolucaoTardia.filter((c) => !vistas.has(`${c.source}|${c.orderKey}`));
  const candidates = [...daJanela, ...extras];

  if (extras.length > 0) {
    logInfo("materialize_orders_resolucao_tardia", {
      day,
      chaves: extras.length,
      // Se bater no teto, sobrou backlog para a proxima rodada -- e o numero
      // que distingue "convergiu" de "esta engolindo aos poucos".
      noTeto: porResolucaoTardia.length >= LATE_RESOLUTION_LIMIT,
    });
  }

  let dedupedOrders = 0;
  let mapped = 0;
  let written = 0;
  const rejections: Record<MaterializationRejection, number> = {
    sem_payload: 0,
    sem_source: 0,
    nao_pago: 0,
    sem_data: 0,
    valor_nao_positivo: 0,
  };
  const produced = new Set<string>();

  // A ordem de `candidates` vem do DISTINCT do passo 1 e nao e garantida entre
  // execucoes, entao ordenar aqui e o que torna `resumeFromKey` significativo:
  // sem isso, retomar do lote 11 pularia um conjunto arbitrario de chaves.
  candidates.sort((a, b) => (a.source === b.source ? a.orderKey.localeCompare(b.orderKey) : a.source.localeCompare(b.source)));

  for (let start = resumeFromKey; start < candidates.length; start += KEY_CHUNK) {
    const chunk = candidates.slice(start, start + KEY_CHUNK);
    const rows = await comRetentativa(`lote ${start}`, () => findMirrorRowsByOrderKeys(chunk));
    dedupedOrders += rows.length;

    const orders: MaterializedOrder[] = [];
    for (const row of rows) {
      const order = toMaterializedOrder(row);
      if (!order) {
        const motivo = describeMaterializationRejection(row);
        if (motivo) rejections[motivo] += 1;
        continue;
      }
      orders.push(order);
      produced.add(keyOf(order));
    }

    mapped += orders.length;
    written += await comRetentativa(`gravacao ${start}`, () => upsertFinancialOrders(orders));

    logInfo("materialize_orders_chunk", {
      day,
      fromKey: start,
      restantes: candidates.length - start - chunk.length,
      keys: chunk.length,
      dedupedOrders: rows.length,
      mapped: orders.length,
    });
  }

  // Passo 5. So chaves DESTE conjunto candidato entram no DELETE -- nunca um
  // "apague tudo que nao esta no resultado", que apagaria a tabela inteira
  // sempre que a janela fosse pequena.
  // So apaga as chaves que ESTA execucao processou. Numa corrida retomada, as
  // chaves anteriores a resumeFromKey nao foram lidas: trata-las como "nao
  // produziram pedido" apagaria linhas corretas.
  const toDelete = candidates
    .slice(resumeFromKey)
    .map((candidate) => ({ source: candidate.source, orderKey: candidate.orderKey }))
    .filter((candidate) => !produced.has(keyOf(candidate)));

  const deleted = await comRetentativa("delete", () => deleteFinancialOrders(toDelete));

  const result: MaterializeDayResult = {
    day,
    candidateKeys: candidates.length,
    dedupedOrders,
    mapped,
    rejections,
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
      dedupedOrders,
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
   * Dias explicitos (YYYY-MM-DD). Sem isto, roda D-0, D-1 e D-2.
   *
   * D-0 entra porque sem ele o dia corrente nunca e materializado: com
   * FINANCIAL_READ_MODEL_MATERIALIZED ligado, "hoje" devolveria R$ 0,00 em
   * silencio -- read-model-coverage.ts trata o piso, nao o teto.
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
  const days = options.days ?? [
    saoPauloDay(reference, 0),
    saoPauloDay(reference, -1),
    saoPauloDay(reference, -2),
  ];

  const results: MaterializeDayResult[] = [];
  for (const day of days) {
    results.push(await materializeOrdersForDay(day));
  }

  return { mode: "day", days: results };
}
