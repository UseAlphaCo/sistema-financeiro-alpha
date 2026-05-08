import { describe, expect, it } from "vitest";

import {
  mapShopifyOrderFinancials,
  normalizeShopifyDisplayOrderNumber,
  resolveShopifyDiscountCents,
  resolveShopifyShippingCents,
} from "@/features/integration/shopify-order-mapper";
import type { ShopifyOrderPayload } from "@/features/integration/types";

function buildOrder(overrides: Partial<ShopifyOrderPayload> = {}): ShopifyOrderPayload {
  return {
    id: "7207102316769",
    order_number: "1439377644132",
    name: "#1439377644132",
    total_price: "102.91",
    total_shipping_price: "0.00",
    total_discounts: "0.00",
    total_tax: "0.00",
    currency: "BRL",
    processed_at: "2026-05-07T19:36:00-03:00",
    created_at: "2026-05-07T19:36:00-03:00",
    ...overrides,
  };
}

describe("shopify-order-mapper", () => {
  it("preserva display do pedido com # quando vem no name", () => {
    const order = buildOrder({ name: "#1439377644132" });
    expect(normalizeShopifyDisplayOrderNumber(order)).toBe("#1439377644132");
  });

  it("concatena payment_gateway_names e mantém raw da Shopify", () => {
    const order = buildOrder({
      payment_gateway_names: ["Pix", "Starkbank"],
    });

    const mapped = mapShopifyOrderFinancials(order);
    expect(mapped.paymentMethodRaw).toBe("Pix | Starkbank");
  });

  it("prioriza frete de total_shipping_price_set", () => {
    const order = buildOrder({
      total_shipping_price: "0.00",
      total_shipping_price_set: {
        shop_money: { amount: "10.91" },
      },
    });

    expect(resolveShopifyShippingCents(order)).toBe(1091);
  });

  it("usa fallback de frete por shipping_lines discounted_price quando necessário", () => {
    const order = buildOrder({
      total_shipping_price: undefined,
      shipping_lines: [{ discounted_price: "7.50" }, { discounted_price: "2.41" }],
    });

    expect(resolveShopifyShippingCents(order)).toBe(991);
  });

  it("prioriza desconto de current_total_discounts_set", () => {
    const order = buildOrder({
      total_discounts: "0.00",
      current_total_discounts_set: {
        shop_money: { amount: "7.98" },
      },
    });

    expect(resolveShopifyDiscountCents(order)).toBe(798);
  });

  it("usa fallback de desconto por line_items quando campos agregados ausentes", () => {
    const order = buildOrder({
      total_discounts: undefined,
      current_total_discounts: undefined,
      line_items: [
        { total_discount_set: { shop_money: { amount: "2.99" } } },
        { total_discount_set: { shop_money: { amount: "4.99" } } },
      ],
    });

    expect(resolveShopifyDiscountCents(order)).toBe(798);
  });
});
