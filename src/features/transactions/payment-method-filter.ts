import { PAYMENT_METHODS, type PaymentMethod } from "@/features/transactions/types";

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

// Ordem de prioridade usada por classifyPaymentMethod(): quando um raw combina
// mais de uma forma de pagamento (ex.: pedido split "Pix | Crédito em loja"),
// store_credit vence porque indica que uma parte do saldo foi resolvida via
// credito da loja, o sinal mais especifico disponivel. Esta e a UNICA fonte de
// verdade de classificacao do sistema — nao duplicar esta logica em outros
// arquivos (ver src/features/integration/payment-method.ts, que delega para
// classifyPaymentMethod, e src/features/transactions/read-model.ts, idem).
const CLASSIFICATION_PRIORITY: readonly PaymentMethod[] = [
  "store_credit",
  "pix",
  "boleto",
  "bank_transfer",
  "credit_card",
  "wallet",
  "cash",
];

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

export function classifyPaymentMethod(rawValue: string | null | undefined): PaymentMethod {
  const raw = (rawValue ?? "").trim();
  if (!raw) return "other";

  const normalizedRaw = normalizeForMatch(raw);

  for (const method of CLASSIFICATION_PRIORITY) {
    if (
      getPaymentMethodSearchTokens(method).some((token) => normalizedRaw.includes(normalizeForMatch(token)))
    ) {
      return method;
    }
  }

  return "other";
}

export function isValidPaymentMethod(value: string | null | undefined): value is PaymentMethod {
  return Boolean(value) && (PAYMENT_METHODS as readonly string[]).includes(value as string);
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

