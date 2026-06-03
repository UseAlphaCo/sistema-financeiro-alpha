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

export type WorkerSummary = {
  fetched: number;
  processed: number;
  failed: number;
  skipped: number;
  retried: number;
  deadLettered: number;
  lockSkipped: boolean;
};
