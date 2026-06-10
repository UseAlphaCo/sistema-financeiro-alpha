import type { PeriodPreset } from "@/lib/date-utils";
import type { PaymentMethod } from "@/features/transactions/types";

export type CashFlowPeriod = {
  startDate: string;
  endDate: string;
  days: number;
  preset?: PeriodPreset;
};

export type CashFlowBySource = {
  source: string;
  grossCents: number;
  feesCents: number;
  netCents: number;
  transactionCount: number;
};

export type CashFlowByPaymentMethod = {
  paymentMethod: PaymentMethod;
  grossCents: number;
  transactionCount: number;
};

export type CashFlowSummary = {
  period: CashFlowPeriod;
  totalIncomeCents: number;
  totalExpenseCents: number;
  totalFeesCents: number;
  totalDiscountCents: number;
  totalShippingCents: number;
  totalTaxCents: number;
  netCents: number;
  bySource: CashFlowBySource[];
  byPaymentMethod: CashFlowByPaymentMethod[];
  previousPeriod: {
    totalIncomeCents: number;
    totalExpenseCents: number;
    totalDiscountCents: number;
    totalShippingCents: number;
    totalTaxCents: number;
    netCents: number;
    byPaymentMethod: CashFlowByPaymentMethod[];
  } | null;
};

export type CashFlowFilters = {
  preset?: PeriodPreset;
  days?: number;
  startDate?: string;
  endDate?: string;
  source?: string;
  marketplace?: string;
  categoryId?: string;
  paymentMethod?: PaymentMethod;
};
