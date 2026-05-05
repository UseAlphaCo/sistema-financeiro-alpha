export type IssueType =
  | "duplicate_external_id"
  | "missing_category"
  | "negative_balance"
  | "orphan_import_row"
  | "unprocessed_webhook";

export interface ReconciliationIssue {
  type: IssueType;
  severity: "error" | "warning" | "info";
  description: string;
  affectedId?: string;
  affectedTable?: string;
  occurredAt?: Date;
}

export interface ReconciliationResult {
  snapshotId: string;
  startDate: Date;
  endDate: Date;
  issueCount: number;
  issues: ReconciliationIssue[];
  ranAt: Date;
}

export interface ReconciliationFilters {
  days?: number;
  startDate?: string;
  endDate?: string;
}
