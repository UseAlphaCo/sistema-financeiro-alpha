import { resolveShopifyPaymentMethod } from "./payment-method";
import type { ShopifyOrderPayload } from "./types";

function parseMoney(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  // Normaliza formato de moeda: suporta vírgula como separador decimal (formato BR)
  const normalized = value.replace(/,/, ".").trim();
  const parsed = parseFloat(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseMoneyToCents(value: string | undefined | null): number {
  const parsed = parseMoney(value);
  if (parsed === null) return 0;
  return Math.round(parsed * 100);
}

function firstMoneyToCents(values: Array<string | undefined | null>): number | null {
  for (const value of values) {
    const parsed = parseMoney(value);
    if (parsed !== null) {
      return Math.round(parsed * 100);
    }
  }

  return null;
}

function sumMoneyToCents(values: Array<string | undefined | null>): number | null {
  let found = false;
  let sum = 0;

  for (const value of values) {
    const parsed = parseMoney(value);
    if (parsed === null) continue;
    found = true;
    sum += parsed;
  }

  if (!found) return null;
  return Math.round(sum * 100);
}

export function resolveOccurredAt(order: ShopifyOrderPayload): Date {
  const raw = order.processed_at ?? order.created_at;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error("invalid occurredAt in Shopify order payload");
  }
  return date;
}

export function normalizeShopifyDisplayOrderNumber(order: ShopifyOrderPayload): string {
  const fromName = typeof order.name === "string" ? order.name.trim() : "";
  if (fromName) {
    return fromName.startsWith("#") ? fromName : `#${fromName}`;
  }

  const fromOrderNumber = String(order.order_number ?? "").trim();
  if (fromOrderNumber) {
    const clean = fromOrderNumber.replace(/^#/, "");
    return `#${clean}`;
  }

  return `#${String(order.id)}`;
}

export function resolveShopifyShippingCents(order: ShopifyOrderPayload): number {
  // Tentativa 1: Valores de frete diretos (agregados na raiz do pedido)
  const directValue = firstMoneyToCents([
    order.total_shipping_price_set?.shop_money?.amount,
    order.current_total_shipping_price_set?.shop_money?.amount,
    order.total_shipping_price,
  ]);

  if (directValue !== null) {
    return directValue;
  }

  // Tentativa 2: Agregação via shipping_lines (com desconto)
  const fromDiscountedSet = sumMoneyToCents(
    (order.shipping_lines ?? []).map((line) => line.discounted_price_set?.shop_money?.amount)
  );
  if (fromDiscountedSet !== null) return fromDiscountedSet;

  const fromDiscounted = sumMoneyToCents(
    (order.shipping_lines ?? []).map((line) => line.discounted_price)
  );
  if (fromDiscounted !== null) return fromDiscounted;

  const fromPrice = sumMoneyToCents((order.shipping_lines ?? []).map((line) => line.price));
  if (fromPrice !== null) return fromPrice;

  // Tentativa 3: Cálculo derivado por balanço (fallback final)
  // frete = total - subtotal + descontos + impostos + taxas
  const totalCents = parseMoneyToCents(order.total_price);
  const subtotalValue = firstMoneyToCents([
    order.subtotal_price,
    order.current_subtotal_price,
  ]);

  if (subtotalValue !== null && totalCents > 0) {
    const discountCents = resolveShopifyDiscountCents(order);
    const taxCents = parseMoneyToCents(order.total_tax);
    const feeCents = parseMoneyToCents(order.current_total_additional_fees_set?.shop_money?.amount);

    // Fórmula: frete derivado = total - subtotal + desconto + imposto + taxa
    // (O desconto já é subtraído na API, então somamos; taxas e fees são adicionadas ao total)
    const derived = totalCents - subtotalValue + discountCents + taxCents + feeCents;

    // Se resultado é plausível (entre -500 e +10000 BRL = -50000 a +1000000 centavos),
    // retorna valor derivado; caso contrário, não confia e retorna 0
    if (derived >= -50000 && derived <= 1000000) {
      return Math.max(0, derived); // Garante que não seja negativo
    }
  }

  return 0;
}

export function resolveShopifyDiscountCents(order: ShopifyOrderPayload): number {
  const directValue = firstMoneyToCents([
    order.current_total_discounts_set?.shop_money?.amount,
    order.total_discounts,
    order.current_total_discounts,
  ]);

  if (directValue !== null) {
    return directValue;
  }

  const fromLineItems = sumMoneyToCents(
    (order.line_items ?? []).map((line) => line.total_discount_set?.shop_money?.amount ?? line.total_discount)
  );
  if (fromLineItems !== null) return fromLineItems;

  return 0;
}

export function mapShopifyOrderFinancials(order: ShopifyOrderPayload) {
  const paymentMethod = resolveShopifyPaymentMethod(order);
  const displayOrderNumber = normalizeShopifyDisplayOrderNumber(order);

  return {
    externalId: String(order.id),
    orderNumber: displayOrderNumber,
    paymentMethodRaw: paymentMethod.raw,
    paymentMethodNormalized: paymentMethod.normalized,
    shippingCents: resolveShopifyShippingCents(order),
    discountCents: resolveShopifyDiscountCents(order),
    taxCents: parseMoneyToCents(order.total_tax),
    feeCents: parseMoneyToCents(order.current_total_additional_fees_set?.shop_money?.amount),
    amountCents: parseMoneyToCents(order.total_price),
    currency: order.currency ?? "BRL",
    occurredAt: resolveOccurredAt(order),
    description: `Pedido ${displayOrderNumber}`,
  };
}
