import { classifyPaymentMethod } from "@/features/transactions/payment-method-filter";
import type { PaymentMethod } from "@/features/transactions/types";
import type { DominantPaymentMethodResult } from "@/features/integration/shopify-order-transactions";

type PaymentMethodInfo = {
  raw: string | null;
  normalized: PaymentMethod;
};

// Mantido apenas para decidir a ORDEM de exibicao quando varios gateways sao
// combinados numa unica string raw (ver dedupeAndJoin/mapGatewayName abaixo).
// A CLASSIFICACAO raw -> PaymentMethod e feita por classifyPaymentMethod()
// (fonte unica em src/features/transactions/payment-method-filter.ts).
const STORE_CREDIT_PATTERNS = [
  /shopify_store_credit/i,
  /shopify\s*store\s*credit/i,
  /store\s*credit/i,
  /credito\s*em\s*loja/i,
  /crédito\s*em\s*loja/i,
];

function normalizeKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function dedupeAndJoin(values: string[]): string | null {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const clean = value.trim();
    if (!clean) continue;
    const key = normalizeKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }

  if (result.length === 0) return null;

  const storeCreditIndex = result.findIndex((item) => STORE_CREDIT_PATTERNS.some((pattern) => pattern.test(item)));
  if (storeCreditIndex > 0) {
    const [storeCredit] = result.splice(storeCreditIndex, 1);
    result.unshift(storeCredit);
  }

  return result.join(" | ");
}

function mapGatewayName(value: string): string {
  if (STORE_CREDIT_PATTERNS.some((pattern) => pattern.test(value))) {
    return "Crédito em loja";
  }
  return value.trim();
}

function extractTagCandidates(tags: string | string[] | null | undefined): string[] {
  if (!tags) return [];

  const rawTags = Array.isArray(tags)
    ? tags
    : tags
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const candidates: string[] = [];

  for (const tag of rawTags) {
    if (!tag) continue;
    if (
      /(pix|starkbank|store\s*credit|shopify_store_credit|credito\s*em\s*loja|crédito\s*em\s*loja|visa|master|amex|elo|card|cartao|cartão|boleto|ted|doc|transfer|paypal|wallet|cash|dinheiro|appmax)/i.test(
        tag
      )
    ) {
      const pieces = tag
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => mapGatewayName(item));
      candidates.push(...pieces);
    }
  }

  return candidates;
}

function getFirstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function joinNonEmpty(values: Array<string | null | undefined>, separator = " | "): string | null {
  const cleaned = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);

  if (cleaned.length === 0) return null;
  return cleaned.join(separator);
}

export function normalizePaymentMethod(rawValue: string | null | undefined): PaymentMethod {
  return classifyPaymentMethod(rawValue);
}

export function resolveShopifyPaymentMethod(
  order: {
    gateway?: string | null;
    payment_gateway_names?: string[] | null;
    note?: string | null;
    tags?: string | string[] | null;
    note_attributes?: Array<{ name?: string; value?: string }> | null;
    transactions?: Array<{
      gateway?: string;
      payment_details?: {
        credit_card?: { brand?: string };
        wallet?: { type?: string };
      };
    }> | null;
  },
  dominant?: DominantPaymentMethodResult | null
): PaymentMethodInfo {
  // Quando o gateway titular ja foi resolvido por valor (maior R$ pago no
  // pedido, calculado a partir das transacoes reais da Shopify), essa e a
  // unica fonte usada — ignora heuristicas por texto abaixo, que so servem de
  // fallback para quando a resolucao por valor ainda nao esta disponivel.
  if (dominant) {
    const raw = mapGatewayName(dominant.gatewayRaw);
    return {
      raw,
      normalized: normalizePaymentMethod(raw),
    };
  }

  const rawFromPaymentGateway = joinNonEmpty((order.payment_gateway_names ?? []).map(mapGatewayName));

  const firstTransaction = order.transactions?.[0];
  const rawFromTransaction = getFirstNonEmpty([
    firstTransaction?.payment_details?.credit_card?.brand,
    firstTransaction?.payment_details?.wallet?.type,
    firstTransaction?.gateway,
    ...(order.transactions ?? []).map((tx) => tx.gateway),
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

  const composedRaw = dedupeAndJoin([
    ...(raw ? raw.split("|").map((item) => mapGatewayName(item)) : []),
    ...extractTagCandidates(order.tags),
  ]);

  const resolvedRaw = composedRaw ?? raw;

  return {
    raw: resolvedRaw,
    normalized: normalizePaymentMethod(resolvedRaw),
  };
}
