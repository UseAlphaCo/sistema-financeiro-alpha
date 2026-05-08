import { resolveShopifyPaymentMethod } from "./payment-method";
import type { ShopifyOrderPayload } from "./types";

function parseMoney(value: string | undefined | null): number | null {
  if (typeof value !== "string") return null;
  const parsed = parseFloat(value);
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
  const directValue = firstMoneyToCents([
    order.total_shipping_price_set?.shop_money?.amount,
    order.current_total_shipping_price_set?.shop_money?.amount,
    order.total_shipping_price,
  ]);

  if (directValue !== null) {
    return directValue;
  }

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
