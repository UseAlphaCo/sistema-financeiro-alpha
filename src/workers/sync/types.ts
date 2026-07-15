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
 * Contrato do armazenamento de controle tecnico da sincronizacao
 * (fila, retry, DLQ e lock). Implementado pelo CORE (padrao) e, para
 * rollback de emergencia, tambem pelo OMS legado.
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
