import { describe, expect, it } from "vitest";

import {
  resolveDominantPaymentMethod,
  type ShopifyOrderTransaction,
} from "@/features/integration/shopify-order-transactions";

function tx(overrides: Partial<ShopifyOrderTransaction> = {}): ShopifyOrderTransaction {
  return {
    gateway: "Pix (3% de desconto)",
    kind: "sale",
    status: "success",
    amountCents: 1000,
    processedAt: "2026-05-26T12:00:00Z",
    ...overrides,
  };
}

describe("resolveDominantPaymentMethod", () => {
  it("retorna null quando nao ha transacao valida", () => {
    expect(resolveDominantPaymentMethod([])).toBeNull();
  });

  it("escolhe o gateway com maior valor no pedido split (exemplo do doc de reconciliacao)", () => {
    const result = resolveDominantPaymentMethod([
      tx({ gateway: "shopify_store_credit", kind: "capture", amountCents: 14719 }),
      tx({ gateway: "Pix (3% de desconto)", kind: "sale", amountCents: 1760 }),
    ]);

    expect(result?.gatewayRaw).toBe("shopify_store_credit");
    expect(result?.dominantAmountCents).toBe(14719);
    expect(result?.totalAmountCents).toBe(16479);
  });

  it("ignora transacoes com status diferente de success", () => {
    const result = resolveDominantPaymentMethod([
      tx({ gateway: "shopify_store_credit", amountCents: 99999, status: "failure" }),
      tx({ gateway: "Pix (3% de desconto)", amountCents: 1000, status: "success" }),
    ]);

    expect(result?.gatewayRaw).toBe("Pix (3% de desconto)");
  });

  it("ignora kind fora de sale/capture/change (ex.: authorization)", () => {
    const result = resolveDominantPaymentMethod([
      tx({ gateway: "shopify_store_credit", amountCents: 99999, kind: "authorization" }),
      tx({ gateway: "Pix (3% de desconto)", amountCents: 1000, kind: "sale" }),
    ]);

    expect(result?.gatewayRaw).toBe("Pix (3% de desconto)");
  });

  it("soma multiplas transacoes do mesmo gateway antes de comparar", () => {
    const result = resolveDominantPaymentMethod([
      tx({ gateway: "Appmax - Cartão de Crédito", kind: "capture", amountCents: 500 }),
      tx({ gateway: "Appmax - Cartão de Crédito", kind: "capture", amountCents: 600 }),
      tx({ gateway: "Pix (3% de desconto)", kind: "sale", amountCents: 1000 }),
    ]);

    expect(result?.gatewayRaw).toBe("Appmax - Cartão de Crédito");
    expect(result?.dominantAmountCents).toBe(1100);
  });

  it("usa prioridade store_credit > pix como desempate em caso de valores iguais", () => {
    const result = resolveDominantPaymentMethod([
      tx({ gateway: "Pix (3% de desconto)", amountCents: 1000 }),
      tx({ gateway: "shopify_store_credit", amountCents: 1000 }),
    ]);

    expect(result?.gatewayRaw).toBe("shopify_store_credit");
  });

  it("usa o processed_at mais recente entre as transacoes do gateway vencedor", () => {
    const result = resolveDominantPaymentMethod([
      tx({ gateway: "Pix (3% de desconto)", amountCents: 500, processedAt: "2026-05-26T10:00:00Z" }),
      tx({ gateway: "Pix (3% de desconto)", amountCents: 500, processedAt: "2026-05-27T02:00:00Z" }),
    ]);

    expect(result?.processedAt).toBe("2026-05-27T02:00:00Z");
  });
});
