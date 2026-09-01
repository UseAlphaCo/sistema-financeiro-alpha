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
  expenseCents: number;
  transactionCount: number;
  /**
   * Em que base a linha foi medida.
   *
   * `orders` — soma o total de cada pedido, uma vez, atribuido inteiro ao
   * gateway que pagou a maior parte. `transactionCount` conta PEDIDOS.
   *
   * `payments` — soma cada perna do pagamento com o seu proprio valor, no dia
   * do proprio processed_at, como o relatorio "Pagamentos brutos por gateway"
   * da Shopify. `transactionCount` conta TRANSACOES.
   *
   * As duas convivem na mesma tabela e nao sao somaveis entre si: por isso a
   * tela precisa dizer qual e qual em vez de exibir uma coluna so.
   */
  basis: "orders" | "payments";
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
  totalDiscountCents: number;
  totalShippingCents: number;
  totalTaxCents: number;
  bySource: CashFlowBySource[];
  byPaymentMethod: CashFlowByPaymentMethod[];
  previousPeriod: {
    totalIncomeCents: number;
    totalExpenseCents: number;
    totalDiscountCents: number;
    totalShippingCents: number;
    totalTaxCents: number;
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
