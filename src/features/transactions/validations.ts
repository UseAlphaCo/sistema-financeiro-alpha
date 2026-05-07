import { z } from "zod";

import {
  PAYMENT_METHODS,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUSES,
  TRANSACTION_TYPES,
} from "@/features/transactions/types";

const dateStringSchema = z.string().datetime({ offset: true });

const sourcesCsvSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  )
  .pipe(z.array(z.enum(TRANSACTION_SOURCES)).min(1));

export const listTransactionsFiltersSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  type: z.enum(TRANSACTION_TYPES).optional(),
  source: z.enum(TRANSACTION_SOURCES).optional(),
  sources: sourcesCsvSchema.optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  marketplace: z.string().trim().min(1).max(50).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  categoryId: z.string().trim().min(1).max(120).optional(),
  startDate: dateStringSchema.optional(),
  endDate: dateStringSchema.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const createTransactionSchema = z.object({
  externalSource: z.string().trim().min(1).max(100).optional(),
  externalId: z.string().trim().min(1).max(200).optional(),
  marketplace: z.string().trim().min(1).max(50).optional(),
  orderNumber: z.string().trim().min(1).max(100).optional(),
  paymentMethodRaw: z.string().trim().min(1).max(100).optional(),
  paymentMethodNormalized: z.enum(PAYMENT_METHODS).optional(),
  shippingCents: z.number().int().min(0).optional(),
  discountCents: z.number().int().min(0).optional(),
  taxCents: z.number().int().min(0).optional(),
  feeCents: z.number().int().min(0).optional(),
  type: z.enum(TRANSACTION_TYPES),
  categoryId: z.string().trim().min(1).max(120).optional(),
  amountCents: z.number().int().positive(),
  currency: z.string().trim().min(3).max(3).default("BRL"),
  occurredAt: dateStringSchema,
  description: z.string().trim().max(1000).optional(),
  source: z.enum(TRANSACTION_SOURCES),
  status: z.enum(TRANSACTION_STATUSES).default("pending"),
  changeReason: z.string().trim().max(300).optional(),
});

export const updateTransactionSchema = z.object({
  id: z.string().trim().min(1),
  categoryId: z.string().trim().min(1).max(120).nullable().optional(),
  amountCents: z.number().int().positive().optional(),
  occurredAt: dateStringSchema.optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(TRANSACTION_STATUSES).optional(),
  changeReason: z.string().trim().max(300).optional(),
});

export const deleteTransactionSchema = z.object({
  id: z.string().trim().min(1),
  changeReason: z.string().trim().max(300).optional(),
});

export type ListTransactionsFiltersInput = z.infer<typeof listTransactionsFiltersSchema>;
export type CreateTransactionInputSchema = z.infer<typeof createTransactionSchema>;
export type UpdateTransactionInputSchema = z.infer<typeof updateTransactionSchema>;
export type DeleteTransactionInputSchema = z.infer<typeof deleteTransactionSchema>;
