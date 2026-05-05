export type ImportBatchStatus = "pending" | "committed" | "rolled_back" | "error";
export type ImportRowStatus = "pending" | "committed" | "error";

export interface ImportRow {
  rowIndex: number;
  occurredAt: Date;
  type: "income" | "expense";
  amountCents: number;
  description?: string;
  category?: string;
  source?: string;
  status: ImportRowStatus;
  errorMsg?: string;
}

export interface ImportBatch {
  id: string;
  source: string;
  fileHash: string;
  status: ImportBatchStatus;
  rowCount: number;
  errorCount: number;
  createdAt: Date;
  rows?: ImportRow[];
}

export interface CsvParseResult {
  rows: ImportRow[];
  errorCount: number;
}

export interface PreviewImportInput {
  csvContent: string;
  source?: string;
}

export interface CommitImportInput {
  batchId: string;
}

export interface RollbackImportInput {
  batchId: string;
}
