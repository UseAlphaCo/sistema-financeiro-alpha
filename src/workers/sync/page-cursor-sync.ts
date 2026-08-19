import { logError, logInfo, logWarn } from "../../core/observability/logger";

import type { WorkerEnv } from "./config";
import type { CoreRepository } from "./repositories/core-repository";
import type { OmsRepository } from "./repositories/oms-repository";
import type { OmsHeapState, RawPayloadCandidate, ScanCursor, ScanPass } from "./types";

/**
 * VARREDURA POR CURSOR FISICO
 * ===========================
 *
 * Por que existe: o cursor logico (tempo) do ciclo incremental depende de um
 * indice em received_at/processed_at que o OMS nao tem, e que nao podemos
 * criar -- o OMS e read-only para esta aplicacao. Medido em 2026-08-18, a
 * consulta de descoberta e um Parallel Seq Scan de 79.785 ms contra um
 * statement_timeout de 30 s: falha por construcao, e falhava assim desde
 * sempre. O resultado foi um mirror com 51% das linhas que deveria ter, sem
 * ninguem perceber.
 *
 * O ctid (pagina fisica do heap) e o unico caminho de acesso que existe sem
 * DDL. PG 17 resolve `ctid >= $1 AND ctid < $2` com Tid Range Scan, e o custo
 * passa a ser proporcional a PAGINAS VARRIDAS -- numero que nos escolhemos --
 * em vez de ao tamanho da tabela.
 *
 * Dois passos, com cursores independentes:
 *
 *   cauda    latencia baixa. Cursor proprio com lookback curto, ate o fim
 *            atual do heap. Tem memoria de proposito: "as ultimas N paginas"
 *            nao alcancaria depois de uma parada de dias.
 *
 *   auditoria completude. Volta ciclica pela tabela inteira, com o fim
 *            congelado no tamanho do heap quando a volta comecou.
 *
 * A auditoria NAO e rede de seguranca -- e o mecanismo principal. Com 377.693
 * tuplas mortas, o FSM reaproveita espaco e linha nova cai em pagina velha
 * rotineiramente; a correlacao de received_at ser 0,954 e nao 1,0 mede
 * exatamente essa fracao. Uma cauda pura perderia essas linhas para sempre.
 *
 * O QUE ESTA VARREDURA GARANTE, E O QUE NAO GARANTE
 * -------------------------------------------------
 * Uma volta fechada NAO prova que o mirror esta completo: linhas migram de
 * pagina em UPDATE nao-HOT (2,37M movimentacoes nesta tabela) e ha a janela
 * MVCC -- uma linha ainda nao commitada quando passamos pela pagina dela e
 * invisivel, e o cursor segue em frente. Ambos se resolvem na volta seguinte.
 * Por isso a garantia honesta e a REGRA DAS DUAS VOLTAS: duas voltas
 * consecutivas sem troca de relfilenode provam completude ate o inicio da
 * primeira. Nao escreva "sincronizado" em lugar nenhum a partir de uma volta
 * so.
 */

/** Paginas relidas atras do cursor de cauda a cada ciclo. */
const TAIL_LOOKBACK_BLOCKS = 500;

/** Linhas por lote de busca de payload. ~330 linhas/s, entao ~1,5 s por lote. */
const FETCH_BATCH_ROWS = 500;

/**
 * Fracao do orcamento reservada a descoberta; o resto vai para a drenagem.
 *
 * A descoberta e barata (~10 s por chunk de 10.000 paginas, incluindo o
 * anti-join) e a drenagem e cara (~330 linhas/s). Sem esta divisao, uma volta
 * de auditoria com muito backlog consumiria o ciclo inteiro descobrindo e nada
 * seria reparado -- ou, no sentido oposto, a drenagem de um backlog grande
 * impediria o cursor de andar. Cada lado tem um pedaco garantido.
 */
const DISCOVERY_BUDGET_RATIO = 0.4;

export type SweepPassResult = {
  pass: ScanPass;
  blocksScanned: number;
  rowsSeen: number;
  rowsMissing: number;
  rowsQueued: number;
  lapClosed: boolean;
};

export type SweepResult = {
  heap: OmsHeapState;
  heapRewritten: boolean;
  passes: SweepPassResult[];
  rowsRepaired: number;
  rowsMissing: number;
  rowsSeen: number;
  rowsQueued: number;
  pendingRepair: number;
  vanished: number;
  deadlineHit: boolean;
};

function toRecord(candidate: RawPayloadCandidate) {
  return {
    id: candidate.id,
    source: candidate.source,
    externalOrderId: candidate.externalOrderId,
    eventType: candidate.eventType,
    payloadJson: candidate.payloadJson,
    headersJson: candidate.headersJson,
    receivedAt: candidate.receivedAt,
    processedAt: candidate.processedAt,
    processingStatus: candidate.processingStatus,
    errorMessage: candidate.errorMessage,
  };
}

/**
 * Detecta reescrita do heap comparando relfilenode.
 *
 * VACUUM FULL, CLUSTER, pg_repack e TRUNCATE trocam o relfilenode e invalidam
 * TODOS os ctid de uma vez. Sem este guarda, o cursor passa a apontar para
 * alem do fim de um heap menor, `ctid >= '(199000,0)'` devolve zero linhas SEM
 * ERRO, e o ciclo registra "ok" enquanto o mirror congela. Seria a assinatura
 * de 11/08 outra vez, agora disfarcada de sucesso.
 *
 * VACUUM simples e ANALYZE nao trocam o relfilenode -- e por isso que pedir um
 * VACUUM ao DBA do OMS e seguro para este desenho.
 */
function detectHeapRewrite(cursor: ScanCursor, heap: OmsHeapState): boolean {
  if (cursor.sourceRelfilenode !== null && cursor.sourceRelfilenode !== heap.relfilenode) {
    return true;
  }

  // Truncamento tambem invalida a posicao: o cursor ficaria alem do fim.
  return cursor.nextBlock > heap.heapBlocks;
}

/**
 * Drena a fila de reparo: busca o payload dos ids pendentes e grava no mirror.
 *
 * Roda ate o deadline. O que sobrar fica na fila para o proximo ciclo -- e por
 * isso que a descoberta pode avancar o cursor sem esperar a transferencia.
 */
async function drainRepairQueue(
  omsRepository: OmsRepository,
  coreRepository: CoreRepository,
  env: WorkerEnv,
  deadlineAt: number,
  cycleId: string
): Promise<{ repaired: number; vanished: number }> {
  let repaired = 0;
  let vanished = 0;

  while (Date.now() < deadlineAt) {
    const pending = await coreRepository.findPendingFetchIds(FETCH_BATCH_ROWS, env.MAX_RETRIES);
    if (pending.length === 0) {
      break;
    }

    const ids = pending.map((item) => item.recordId);

    try {
      // Timing separado de leitura e escrita: sem isso nao se sabe se o limite
      // e a banda do OMS ou a escrita no mirror, e a estimativa de quanto falta
      // para a paridade viraria chute.
      const readStartedAt = Date.now();
      const rows = await omsRepository.findRawPayloadsByIds(ids);
      const readMs = Date.now() - readStartedAt;

      const writeStartedAt = Date.now();
      if (rows.length > 0) {
        repaired += await coreRepository.upsertRawPayloadsBatch(rows.map(toRecord));
      }
      const writeMs = Date.now() - writeStartedAt;

      logInfo("sync_repair_batch", {
        cycleId,
        rows: rows.length,
        readMs,
        writeMs,
        rowsPerSec: Math.round((rows.length / Math.max(readMs + writeMs, 1)) * 1000),
      });

      // Sai da fila tudo que foi pedido: o que voltou porque esta no mirror, e
      // o que nao voltou porque a linha nao existe mais no OMS. Deixar o
      // residuo na fila o faria ser retentado MAX_RETRIES vezes e ir para a
      // DLQ, envenenando a fila com linhas que nunca vao aparecer.
      await coreRepository.markFetchSynced(ids);

      if (rows.length < ids.length) {
        const gone = ids.length - rows.length;
        vanished += gone;
        logWarn("sync_fetch_rows_vanished", {
          cycleId,
          requested: ids.length,
          returned: rows.length,
          vanished: gone,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await coreRepository.markFetchFailed(ids, message);
      logError("sync_fetch_batch_failed", { cycleId, batch: ids.length, error: message });
      break;
    }
  }

  return { repaired, vanished };
}

/**
 * Executa um passo de varredura ate o deadline ou ate o fim da faixa.
 *
 * Descobre e ENFILEIRA; nao transfere payload. O cursor avanca por chunk,
 * depois que os ids ausentes daquele chunk estao duraveis na fila -- nunca
 * antes. Hoje o ciclo incremental faz enqueueBackfill e setWatermark como
 * operacoes separadas (service.ts:85-93): um crash entre as duas perde a
 * janela para sempre, e e uma das causas mecanicas plausiveis do buraco de 51%.
 */
async function runPass(
  pass: ScanPass,
  heap: OmsHeapState,
  omsRepository: OmsRepository,
  coreRepository: CoreRepository,
  env: WorkerEnv,
  deadlineAt: number,
  cycleId: string,
  stream: string
): Promise<SweepPassResult> {
  const cursor = await coreRepository.getScanCursor(stream, pass);

  if (detectHeapRewrite(cursor, heap)) {
    logWarn("sync_heap_rewritten", {
      cycleId,
      pass,
      previousRelfilenode: cursor.sourceRelfilenode,
      currentRelfilenode: heap.relfilenode,
      previousNextBlock: cursor.nextBlock,
      heapBlocks: heap.heapBlocks,
    });

    cursor.nextBlock = 0;
    cursor.lapStartBlock = 0;
    cursor.lapEndBlock = null;
    cursor.blocksCovered = 0;
  }

  cursor.sourceRelfilenode = heap.relfilenode;
  cursor.sourceHeapBlocks = heap.heapBlocks;

  // A cauda persegue o fim atual do heap; a auditoria trabalha com o fim
  // congelado no inicio da volta -- senao a volta persegue uma tabela que
  // cresce ~1.700 paginas/dia e nunca fecha, e a regra das duas voltas nunca
  // produz garantia nenhuma.
  let endBlock: number;
  if (pass === "tail") {
    endBlock = heap.heapBlocks;
    // Cursor de cauda virgem comeca junto ao fim do heap, nao em zero: varrer
    // o historico e trabalho da auditoria. Sem isto a cauda faz uma varredura
    // completa disfarcada e consome todo o orcamento, deixando a auditoria --
    // que e a garantia de completude -- sem tempo nenhum.
    if (cursor.lastRunAt === null && cursor.nextBlock === 0) {
      cursor.nextBlock = Math.max(heap.heapBlocks - TAIL_LOOKBACK_BLOCKS, 0);
    } else {
      cursor.nextBlock = Math.max(cursor.nextBlock - TAIL_LOOKBACK_BLOCKS, 0);
    }
  } else {
    if (cursor.lapEndBlock === null) {
      cursor.lapStartBlock = 0;
      cursor.lapEndBlock = heap.heapBlocks;
      cursor.nextBlock = 0;
      cursor.blocksCovered = 0;
    }
    endBlock = cursor.lapEndBlock;
  }

  let blocksScanned = 0;
  let rowsSeen = 0;
  let rowsMissing = 0;
  let rowsQueued = 0;
  let lapClosed = false;
  const startBlock = cursor.nextBlock;

  while (cursor.nextBlock < endBlock && Date.now() < deadlineAt) {
    const from = cursor.nextBlock;
    const to = Math.min(from + env.SYNC_CHUNK_BLOCKS, endBlock);

    const keys = await omsRepository.findKeysInPageRange(from, to);
    rowsSeen += keys.length;

    const missingIds = await coreRepository.findMissingRawPayloadIds(keys.map((k) => k.id));
    rowsMissing += missingIds.length;

    // Enfileira e so entao avanca. A fila e durable e guarda so ids, entao
    // este passo custa um round-trip qualquer que seja o tamanho do buraco.
    const queued = await coreRepository.enqueueMissingIds(missingIds);
    rowsQueued += queued;

    cursor.nextBlock = to;
    cursor.blocksCovered += to - from;
    blocksScanned += to - from;

    logInfo("sync_page_chunk", {
      cycleId,
      pass,
      fromBlock: from,
      toBlock: to,
      rowsSeen: keys.length,
      rowsMissing: missingIds.length,
      rowsQueued: queued,
    });
  }

  if (pass === "audit" && cursor.nextBlock >= endBlock) {
    // Volta fechada: verifica a invariante antes de contabilizar.
    const expected = endBlock - cursor.lapStartBlock;
    if (cursor.blocksCovered < expected) {
      logError("sync_lap_incomplete", {
        cycleId,
        lapNumber: cursor.lapNumber,
        blocksCovered: cursor.blocksCovered,
        expected,
      });
    } else {
      lapClosed = true;
      cursor.lapNumber += 1;
      logInfo("sync_lap_closed", {
        cycleId,
        lapNumber: cursor.lapNumber,
        blocksCovered: cursor.blocksCovered,
      });
    }

    // Proxima volta recomeca do zero contra o heap daquele momento.
    cursor.lapEndBlock = null;
    cursor.nextBlock = 0;
    cursor.blocksCovered = 0;
  }

  if (pass === "tail") {
    cursor.nextBlock = Math.min(cursor.nextBlock, heap.heapBlocks);
  }

  cursor.consecutiveErrors = 0;
  await coreRepository.saveScanCursor(cursor, cursor.nextBlock !== startBlock);

  return { pass, blocksScanned, rowsSeen, rowsMissing, rowsQueued, lapClosed };
}

/**
 * Um ciclo completo: cauda (latencia) e depois auditoria (completude), dentro
 * de um orcamento de tempo.
 *
 * O deadline interno existe para terminar limpo dentro do maxDuration de 60 s
 * da rota de cron, em vez de ser morto no meio de um chunk.
 */
export async function sweepByPageCursor(
  omsRepository: OmsRepository,
  coreRepository: CoreRepository,
  env: WorkerEnv,
  cycleId: string,
  stream: string
): Promise<SweepResult> {
  const deadlineAt = Date.now() + env.SYNC_CYCLE_BUDGET_MS;
  const heap = await omsRepository.getHeapState();

  const tailCursor = await coreRepository.getScanCursor(stream, "tail");
  const heapRewritten = detectHeapRewrite(tailCursor, heap);

  logInfo("sync_sweep_started", {
    cycleId,
    relfilenode: heap.relfilenode,
    heapBlocks: heap.heapBlocks,
    chunkBlocks: env.SYNC_CHUNK_BLOCKS,
    budgetMs: env.SYNC_CYCLE_BUDGET_MS,
  });

  // Fase 1: descoberta (barata). Avanca os cursores e enfileira ids ausentes.
  const discoveryDeadline = Date.now() + Math.floor(env.SYNC_CYCLE_BUDGET_MS * DISCOVERY_BUDGET_RATIO);
  const passes: SweepPassResult[] = [];
  for (const pass of ["tail", "audit"] as const) {
    passes.push(
      await runPass(pass, heap, omsRepository, coreRepository, env, discoveryDeadline, cycleId, stream)
    );
  }

  // Fase 2: drenagem (cara). Consome a fila no ritmo que a banda permitir.
  const drain = await drainRepairQueue(omsRepository, coreRepository, env, deadlineAt, cycleId);
  const pendingRepair = await coreRepository.countPendingFetch();

  const result: SweepResult = {
    heap,
    heapRewritten,
    passes,
    rowsRepaired: drain.repaired,
    rowsMissing: passes.reduce((acc, p) => acc + p.rowsMissing, 0),
    rowsSeen: passes.reduce((acc, p) => acc + p.rowsSeen, 0),
    rowsQueued: passes.reduce((acc, p) => acc + p.rowsQueued, 0),
    pendingRepair,
    vanished: drain.vanished,
    deadlineHit: Date.now() >= deadlineAt,
  };

  logInfo("sync_sweep_finished", {
    cycleId,
    rowsSeen: result.rowsSeen,
    rowsMissing: result.rowsMissing,
    rowsQueued: result.rowsQueued,
    rowsRepaired: result.rowsRepaired,
    pendingRepair: result.pendingRepair,
    vanished: result.vanished,
    deadlineHit: result.deadlineHit,
    passes: passes.map((p) => ({
      pass: p.pass,
      blocks: p.blocksScanned,
      seen: p.rowsSeen,
      missing: p.rowsMissing,
      lapClosed: p.lapClosed,
    })),
  });

  return result;
}
