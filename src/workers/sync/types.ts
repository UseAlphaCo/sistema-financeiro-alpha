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
 * Contrato do armazenamento de controle tecnico da sincronizacao
 * (fila, retry, DLQ e lock). Implementado pelo CORE (padrao) e, para
 * rollback de emergencia, tambem pelo OMS legado.
 *
 * A marca d'agua NAO faz parte deste contrato de proposito: ela e sempre
 * gravada no CORE, mesmo com SYNC_CONTROL_TARGET=oms, para que o avanco do
 * keyset nunca dependa de escrita no OMS. Ver CoreRepository.setWatermark.
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
