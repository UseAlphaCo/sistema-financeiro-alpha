import type { FinancialTransaction, PaymentMethod } from "@/features/transactions/types";

// Modulo puro (sem dependencia de server: prisma, pg, etc.) — usado tanto por
// codigo server-only (export-jobs.ts) quanto por componentes client
// (FluxoDeCaixaTable.tsx). Nao importar nada server-only aqui.
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  credit_card: "Cartão de crédito",
  pix: "Pix",
  store_credit: "Crédito em loja",
  boleto: "Boleto",
  bank_transfer: "Transferência",
  wallet: "Carteira digital",
  cash: "Dinheiro",
  other: "Outro",
};

export function parseOrderNumber(item: FinancialTransaction): string {
  if (item.orderNumber) {
    const clean = item.orderNumber.replace(/^#/, "");
    return `#${clean}`;
  }

  if (!item.description) return "—";

  const match = item.description.match(/Pedido\s*#\s*([\w-]+)/i);
  return match ? `#${match[1].replace(/^#/, "")}` : "—";
}

export function formatPaymentMethod(item: FinancialTransaction): string {
  if (item.paymentMethodRaw) return item.paymentMethodRaw;
  if (item.paymentMethodNormalized) {
    return PAYMENT_METHOD_LABELS[item.paymentMethodNormalized];
  }
  return "Não informado";
}
