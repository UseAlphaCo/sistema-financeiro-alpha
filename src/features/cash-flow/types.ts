export type CashFlowPeriod = {
  startDate: string;
  endDate: string;
  days: number;
};

export type CashFlowBySource = {
  source: string;
  grossCents: number;
  feesCents: number;
  netCents: number;
  transactionCount: number;
};

export type CashFlowSummary = {
  period: CashFlowPeriod;
  totalIncomeCents: number;
  totalExpenseCents: number;
  totalFeesCents: number;
  netCents: number;
  bySource: CashFlowBySource[];
  previousPeriod: {
    totalIncomeCents: number;
    totalExpenseCents: number;
    netCents: number;
  } | null;
};

export type CashFlowFilters = {
  days?: number;
  startDate?: string;
  endDate?: string;
  source?: string;
  categoryId?: string;
};
