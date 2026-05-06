import type { PaymentMethod } from "@/features/transactions/types";

type PaymentMethodInfo = {
  raw: string | null;
  normalized: PaymentMethod;
};

const PIX_PATTERNS = [/\bpix\b/i];
const BOLETO_PATTERNS = [/\bboleto\b/i, /bank\s*slip/i];
const BANK_TRANSFER_PATTERNS = [/\bted\b/i, /\bdoc\b/i, /bank\s*transfer/i, /wire/i];
const CREDIT_CARD_PATTERNS = [/credit/i, /visa/i, /master/i, /amex/i, /elo/i, /card/i];
const WALLET_PATTERNS = [/paypal/i, /mercado\s*pay/i, /apple\s*pay/i, /google\s*pay/i, /wallet/i];
const CASH_PATTERNS = [/\bcash\b/i, /dinheiro/i];

function getFirstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

export function normalizePaymentMethod(rawValue: string | null | undefined): PaymentMethod {
  const raw = (rawValue ?? "").trim();
  if (!raw) return "other";

  if (PIX_PATTERNS.some((pattern) => pattern.test(raw))) return "pix";
  if (BOLETO_PATTERNS.some((pattern) => pattern.test(raw))) return "boleto";
  if (BANK_TRANSFER_PATTERNS.some((pattern) => pattern.test(raw))) return "bank_transfer";
  if (CREDIT_CARD_PATTERNS.some((pattern) => pattern.test(raw))) return "credit_card";
  if (WALLET_PATTERNS.some((pattern) => pattern.test(raw))) return "wallet";
  if (CASH_PATTERNS.some((pattern) => pattern.test(raw))) return "cash";

  return "other";
}

export function resolveShopifyPaymentMethod(order: {
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
}): PaymentMethodInfo {
  const raw = getFirstNonEmpty([
    order.payment_gateway_names?.[0] ?? null,
    order.gateway ?? null,
  ]);

  return {
    raw,
    normalized: normalizePaymentMethod(raw),
  };
}
