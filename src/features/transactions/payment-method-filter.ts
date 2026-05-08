import type { PaymentMethod } from "@/features/transactions/types";

const METHOD_TOKENS: Record<PaymentMethod, string[]> = {
  credit_card: [
    "cartao de credito",
    "cartão de crédito",
    "credit card",
    "appmax",
    "visa",
    "master",
    "amex",
    "elo",
  ],
  pix: ["pix", "starkbank"],
  boleto: ["boleto", "bank slip"],
  bank_transfer: ["transferencia", "transferência", "bank transfer", "ted", "doc", "wire"],
  wallet: ["carteira digital", "wallet", "paypal", "mercado pay", "apple pay", "google pay"],
  cash: ["dinheiro", "cash"],
  store_credit: [
    "credito em loja",
    "crédito em loja",
    "shopify store credit",
    "store credit",
    "shopify_store_credit",
  ],
  other: [],
};

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function getPaymentMethodSearchTokens(method: PaymentMethod): string[] {
  return METHOD_TOKENS[method];
}

export function paymentRawMatchesMethod(raw: string | null | undefined, method: PaymentMethod): boolean {
  if (!raw) return false;
  const normalizedRaw = normalizeForMatch(raw);
  return getPaymentMethodSearchTokens(method).some((token) => normalizedRaw.includes(normalizeForMatch(token)));
}

export function transactionMatchesPaymentMethod(
  tx: { paymentMethodNormalized?: string | null; paymentMethodRaw?: string | null },
  method: PaymentMethod
): boolean {
  if (tx.paymentMethodNormalized === method) {
    return true;
  }

  return paymentRawMatchesMethod(tx.paymentMethodRaw, method);
}
