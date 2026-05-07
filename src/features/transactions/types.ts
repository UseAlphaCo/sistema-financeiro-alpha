export const TRANSACTION_TYPES = ["income", "expense", "transfer"] as const;
export const TRANSACTION_STATUSES = ["pending", "approved", "rejected", "applied"] as const;
export const TRANSACTION_SOURCES = ["manual", "import", "integration", "webhook"] as const;
export const PAYMENT_METHODS = [
  "credit_card",
  "pix",
  "boleto",
  "bank_transfer",
  "wallet",
  "cash",
  "other",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type FinancialTransaction = {
  id: string;
  externalSource: string | null;
  externalId: string | null;
  marketplace: string | null;
  orderNumber: string | null;
  paymentMethodRaw: string | null;
  paymentMethodNormalized: PaymentMethod | null;
  shippingCents: number;
  discountCents: number;
  taxCents: number;
  feeCents: number;
  type: TransactionType;
  categoryId: string | null;
  amountCents: number;
  currency: string;
  occurredAt: string;
  description: string | null;
  source: TransactionSource;
  status: TransactionStatus;
  createdBy: string | null;
  updatedBy: string | null;
  changeReason: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};

export type CreateTransactionInput = {
  externalSource?: string;
  externalId?: string;
  marketplace?: string;
  orderNumber?: string;
  paymentMethodRaw?: string;
  paymentMethodNormalized?: PaymentMethod;
  shippingCents?: number;
  discountCents?: number;
  taxCents?: number;
  feeCents?: number;
  type: TransactionType;
  categoryId?: string;
  amountCents: number;
  currency?: string;
  occurredAt: string;
  description?: string;
  source: TransactionSource;
  status?: TransactionStatus;
  changeReason?: string;
};

export type UpdateTransactionInput = {
  id: string;
  categoryId?: string | null;
  amountCents?: number;
  occurredAt?: string;
  description?: string | null;
  status?: TransactionStatus;
  changeReason?: string;
};

export type ListTransactionsFilters = {
  page: number;
  limit: number;
  type?: TransactionType;
  source?: TransactionSource;
  sources?: TransactionSource[];
  status?: TransactionStatus;
  marketplace?: string;
  paymentMethod?: PaymentMethod;
  categoryId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
};

export type PaginatedTransactions = {
  items: FinancialTransaction[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
  };
};
