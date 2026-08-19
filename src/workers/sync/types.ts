export type SyncOperation = "INSERT" | "UPDATE" | "DELETE";

export type SyncEventRow = {
  id: number;
  tableName: string;
  recordId: string;
  operation: SyncOperation;
  payload: unknown;
  retries: number;
  nextRetryAt: Date | null;
};

export type RawPayloadRecord = {
  id: string;
  source: string | null;
  externalOrderId: string | null;
  eventType: string | null;
  payloadJson: unknown;
  headersJson: unknown;
  receivedAt: Date | null;
  processedAt: Date | null;
  processingStatus: string | null;
  errorMessage: string | null;
};

export type RawPayloadCandidate = {
  id: string;
  source: string | null;
  externalOrderId: string | null;
  eventType: string | null;
  payloadJson: unknown;
  headersJson: unknown;
  receivedAt: Date | null;
  processedAt: Date | null;
  processingStatus: string | null;
  errorMessage: string | null;
};

/**
 * Posicao do keyset de descoberta incremental. Ordena por
 * (sortAt, recordId), onde sortAt e COALESCE(received_at, processed_at) na
 * origem. Null significa "nunca leu" — o ciclo inicializa antes de usar.
 */
export type SyncWatermark = {
  sortAt: Date;
  recordId: string;
};

/**
 * Estado fisico do heap de public.raw_payloads no OMS.
 *
 * `relfilenode` e o guarda contra reescrita: VACUUM FULL, CLUSTER, pg_repack e
 * TRUNCATE trocam esse numero e invalidam TODOS os ctid de uma vez. Sem
 * compara-lo a cada ciclo, um cursor fisico passa a apontar para o vacuo e
 * devolve zero linhas sem erro -- o mirror congela com o log dizendo "ok".
 * VACUUM simples e ANALYZE nao trocam.
 *
 * `heapBlocks` vem de pg_relation_size/block_size e NAO de pg_class.relpages:
 * medido em 2026-08-18, relpages estava em 199.528 contra 200.898 reais. Quem
 * usa relpages subestima o fim do heap e nunca le a cauda.
 */
export type OmsHeapState = {
  relfilenode: string;
  heapBlocks: number;
};

/**
 * Chave leve de descoberta: o que basta para decidir se a linha falta ou
 * divergiu, sem trazer payload_json/headers_json.
 *
 * A assimetria que sustenta o desenho todo: payload_json e headers_json estao
 * TOASTeados (1569 MB de heap para 2,17M linhas = ~757 bytes/tupla, com
 * payloads de 10-30 KB). Ler estas colunas nao toca no TOAST -- 10.000 paginas
 * saem em ~4 s. Incluir o payload aqui detoastaria a tabela inteira e levaria
 * a descoberta de minutos para horas.
 */
export type RawPayloadKey = {
  id: string;
  source: string | null;
  receivedAt: Date | null;
  processedAt: Date | null;
  processingStatus: string | null;
};

/**
 * Passo de varredura. Sao dois cursores independentes sobre o mesmo heap:
 *
 * - `tail`: cursor proprio com lookback curto, indo ate o fim atual do heap.
 *   Da latencia baixa para o que acabou de chegar. Tem memoria de proposito --
 *   "as ultimas N paginas" nao alcancaria depois de uma parada de dias.
 * - `audit`: volta ciclica pela tabela inteira, com o fim congelado no tamanho
 *   do heap quando a volta comecou. E a UNICA garantia de completude: com o FSM
 *   reaproveitando espaco de 377.693 tuplas mortas, linha nova cai em pagina
 *   velha rotineiramente (a correlacao de received_at ser 0,954 e nao 1,0 mede
 *   exatamente isso), e a cauda sozinha perderia essas linhas para sempre.
 */
export type ScanPass = "tail" | "audit";

/**
 * Posicao de varredura fisica, por bloco (nunca por tid): a fronteira de chunk
 * e sempre um bloco inteiro, para que nao exista a tentacao de retomar no meio
 * de um bloco depois de um LIMIT -- que abriria um buraco periodico.
 */
export type ScanCursor = {
  stream: string;
  pass: ScanPass;
  nextBlock: number;
  lapStartBlock: number;
  lapEndBlock: number | null;
  blocksCovered: number;
  sourceRelfilenode: string | null;
  sourceHeapBlocks: number | null;
  lapNumber: number;
  consecutiveErrors: number;
  /** Null = cursor nunca rodou. A cauda usa isso para nascer junto ao fim do heap. */
  lastRunAt: Date | null;
};

/**
 * Contrato do armazenamento de controle tecnico da sincronizacao
 * (fila, retry, DLQ e lock). Implementado exclusivamente pelo CORE
 * (CoreRepository) -- o OMS e fonte de leitura e nao ha fallback que
 * escreva nele.
 *
 * A marca d'agua NAO faz parte deste contrato de proposito: ela e sempre
 * gravada no CORE, para que o avanco do keyset nunca dependa de escrita no
 * OMS. Ver CoreRepository.setWatermark.
 */
export interface SyncControlStore {
  ensureInfrastructure(): Promise<void>;
  acquireExecutionLock(lockKey: number): Promise<boolean>;
  releaseExecutionLock(lockKey: number): Promise<void>;
  enqueueBackfill(candidates: RawPayloadCandidate[]): Promise<number>;
  findPendingEvents(batchSize: number, maxRetries: number): Promise<SyncEventRow[]>;
  markSynced(eventId: number): Promise<void>;
  markFailed(event: SyncEventRow, errorMessage: string): Promise<number>;
  moveToDeadLetter(event: SyncEventRow, retries: number, errorMessage: string): Promise<void>;
}

export type WorkerSummary = {
  phase: "queued" | "running" | "backfill_enqueued" | "processing_events" | "completed" | "failed" | "lock_skipped";
  fetched: number;
  processed: number;
  failed: number;
  skipped: number;
  retried: number;
  deadLettered: number;
  lockSkipped: boolean;
};
