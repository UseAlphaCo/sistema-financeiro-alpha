import { describe, expect, it } from "vitest";

import {
  mapShopifyOrderFinancials,
  normalizeShopifyDisplayOrderNumber,
  resolveOccurredAt,
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

  it("compõe forma com crédito em loja e tags secundárias", () => {
    const order = buildOrder({
      payment_gateway_names: ["shopify_store_credit"],
      tags: ["Pix | Starkbank", "webhook.rastreio.v2"],
    });

    const mapped = mapShopifyOrderFinancials(order);
    expect(mapped.paymentMethodRaw).toBe("Crédito em loja | Pix | Starkbank");
    expect(mapped.paymentMethodNormalized).toBe("store_credit");
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

  it("suporta formato de moeda com vírgula decimal (formato BR)", () => {
    const order = buildOrder({
      total_shipping_price: "10,50",
      total_discounts: "5,99",
    });

    expect(resolveShopifyShippingCents(order)).toBe(1050);
    expect(resolveShopifyDiscountCents(order)).toBe(599);
  });

  it("calcula frete derivado quando todos os campos diretos estão vazios", () => {
    const order = buildOrder({
      total_price: "102.91",
      subtotal_price: "90.00", // 90.00
      total_shipping_price: undefined,
      total_shipping_price_set: undefined,
      current_total_shipping_price_set: undefined,
      shipping_lines: [],
      total_tax: "0.00",
      total_discounts: "0.00",
      current_total_additional_fees_set: undefined,
    });

    const shippingCents = resolveShopifyShippingCents(order);
    // Derivado = total (10291) - subtotal (9000) + desconto (0) + imposto (0) + taxa (0) = 1291
    expect(shippingCents).toBe(1291);
  });

  it("usa o gateway titular resolvido por valor quando disponivel, ignorando a heuristica de payment_gateway_names", () => {
    const order = buildOrder({
      payment_gateway_names: ["Pix", "shopify_store_credit"],
    });

    const mapped = mapShopifyOrderFinancials(order, {
      gatewayRaw: "shopify_store_credit",
      dominantAmountCents: 14719,
      totalAmountCents: 16479,
      processedAt: "2026-05-27T02:00:00.000Z",
    });

    expect(mapped.paymentMethodRaw).toBe("Crédito em loja");
    expect(mapped.paymentMethodNormalized).toBe("store_credit");
  });

  it("usa o processed_at da transacao titular como occurredAt quando disponivel", () => {
    const order = buildOrder({
      processed_at: "2026-05-26T19:36:00-03:00",
      created_at: "2026-05-26T19:36:00-03:00",
    });

    const occurredAt = resolveOccurredAt(order, {
      gatewayRaw: "Pix",
      dominantAmountCents: 1000,
      totalAmountCents: 1000,
      processedAt: "2026-05-27T02:00:00.000Z",
    });

    expect(occurredAt.toISOString()).toBe("2026-05-27T02:00:00.000Z");
  });

  it("retorna 0 quando frete derivado resulta em valor implausível (negativo)", () => {
    const order = buildOrder({
      total_price: "50.00",
      subtotal_price: "100.00", // subtotal > total é impossível, deve retornar 0
      total_shipping_price: undefined,
      shipping_lines: [],
    });

    // Derivado seria negativo, logo retorna 0
    expect(resolveShopifyShippingCents(order)).toBe(0);
  });
});
