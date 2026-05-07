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
  note?: string | null;
  note_attributes?: Array<{ name?: string; value?: string }> | null;
  transactions?: Array<{
    gateway?: string;
    payment_details?: {
      credit_card?: { brand?: string };
      wallet?: { type?: string };
    };
  }> | null;
}): PaymentMethodInfo {
  const rawFromPaymentGateway = getFirstNonEmpty([order.payment_gateway_names?.[0] ?? null]);

  const firstTransaction = order.transactions?.[0];
  const rawFromTransaction = getFirstNonEmpty([
    firstTransaction?.payment_details?.credit_card?.brand,
    firstTransaction?.payment_details?.wallet?.type,
    firstTransaction?.gateway,
  ]);

  const rawFromNoteAttribute =
    order.note_attributes
      ?.find((attr) => /payment|metodo|forma|gateway/i.test(attr.name ?? ""))
      ?.value ?? null;

  const rawFromNote = (() => {
    const note = (order.note ?? "").trim();
    if (!note) return null;
    const match = note.match(/(pix|boleto|ted|doc|transfer|visa|master|elo|amex|card|paypal)/i);
    return match?.[1] ?? null;
  })();

  const raw = getFirstNonEmpty([
    rawFromPaymentGateway,
    rawFromTransaction,
    order.gateway ?? null,
    rawFromNoteAttribute,
    rawFromNote,
  ]);

  return {
    raw,
    normalized: normalizePaymentMethod(raw),
  };
}
