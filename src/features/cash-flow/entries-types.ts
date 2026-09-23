import type { CashFlowPeriod } from "@/features/cash-flow/types";
import type { PeriodPreset } from "@/lib/date-utils";
import type { FinancialTransaction, TransactionType } from "@/features/transactions/types";

/**
 * Tela Fluxo de Caixa: so lancamentos cadastrados (`manual` e `import`), nunca
 * vendas de marketplace. Ver docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md.
 *
 * INVARIANTE: estes filtros nao tem `marketplace` nem `paymentMethod`. O
 * redirect condicional de next.config.ts usa essas duas querystrings para
 * reconhecer links antigos da tela de Marketplaces.
 */
export type CashFlowEntriesFilters = {
  preset?: PeriodPreset;
  startDate?: string;
  endDate?: string;
  categoryId?: string;
  type?: TransactionType;
  page?: number;
  limit?: number;
};

export type CashFlowEntriesTotals = {
  incomeCents: number;
  expenseCents: number;
  /** Entradas menos saidas. Transferencias nunca entram. */
  balanceCents: number;
  incomeCount: number;
  expenseCount: number;
  transferCount: number;
};

export type CashFlowEntriesByCategory = {
  /** null = "Sem categoria". */
  categoryId: string | null;
  name: string;
  color: string | null;
  totalCents: number;
  count: number;
  /** Fracao do total do mesmo tipo, de 0 a 1. */
  share: number;
};

export type CashFlowEntriesSummary = {
  period: CashFlowPeriod;
  totals: CashFlowEntriesTotals;
  /**
   * null = "sem base": o periodo anterior nao tem nenhum lancamento. E diferente
   * de uma base com totais zero, e a tela nao pode mostrar "+0,0%" nesse caso.
   */
  previousTotals: CashFlowEntriesTotals | null;
  byCategory: {
    income: CashFlowEntriesByCategory[];
    expense: CashFlowEntriesByCategory[];
  };
  items: FinancialTransaction[];
  pagination: { page: number; limit: number; total: number; hasNext: boolean };
};
