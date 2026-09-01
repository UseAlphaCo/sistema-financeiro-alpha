import { describe, expect, it } from "vitest";

import {
  resolveDominantPaymentMethod,
  resolvePaymentGatewaySplit,
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

describe("resolvePaymentGatewaySplit", () => {
  it("retorna array vazio quando nao ha transacao valida", () => {
    expect(resolvePaymentGatewaySplit([])).toEqual([]);
  });

  it("retorna uma entrada por gateway, sem perder o perdedor (diferenca do dominante)", () => {
    const result = resolvePaymentGatewaySplit([
      tx({ gateway: "shopify_store_credit", kind: "capture", amountCents: 14719 }),
      tx({ gateway: "Pix (3% de desconto)", kind: "sale", amountCents: 1760 }),
    ]);

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gatewayRaw: "shopify_store_credit", amountCents: 14719 }),
        expect.objectContaining({ gatewayRaw: "Pix (3% de desconto)", amountCents: 1760 }),
      ])
    );
  });

  it("pedido de 1 gateway so retorna 1 entrada", () => {
    const result = resolvePaymentGatewaySplit([tx({ gateway: "Pix (3% de desconto)", amountCents: 1000 })]);

    expect(result).toEqual([
      expect.objectContaining({ gatewayRaw: "Pix (3% de desconto)", amountCents: 1000 }),
    ]);
  });

  it("ignora transacoes com status/kind fora do escopo, igual resolveDominantPaymentMethod", () => {
    const result = resolvePaymentGatewaySplit([
      tx({ gateway: "shopify_store_credit", amountCents: 99999, status: "failure" }),
      tx({ gateway: "shopify_store_credit", amountCents: 99999, kind: "authorization" }),
      tx({ gateway: "Pix (3% de desconto)", amountCents: 1000, status: "success", kind: "sale" }),
    ]);

    expect(result).toEqual([expect.objectContaining({ gatewayRaw: "Pix (3% de desconto)", amountCents: 1000 })]);
  });

  // A metrica "Transacoes" do relatorio da Shopify conta eventos de pagamento,
  // nao pedidos: em 30/08/2026 marcou 1.143 contra 1.128 pedidos. Contar aqui e
  // o que torna a coluna da tela exata, em vez de aproximada por pares
  // (pedido, gateway).
  it("conta quantas transacoes cada gateway teve no pedido", () => {
    const result = resolvePaymentGatewaySplit([
      tx({ gateway: "Appmax - Cartão de Crédito", kind: "capture", amountCents: 500 }),
      tx({ gateway: "Appmax - Cartão de Crédito", kind: "capture", amountCents: 600 }),
      tx({ gateway: "Pix (3% de desconto)", kind: "sale", amountCents: 1000 }),
    ]);

    const porGateway = new Map(result.map((entry) => [entry.gatewayRaw, entry]));
    expect(porGateway.get("Appmax - Cartão de Crédito")).toMatchObject({
      amountCents: 1100,
      transactionCount: 2,
    });
    expect(porGateway.get("Pix (3% de desconto)")).toMatchObject({ amountCents: 1000, transactionCount: 1 });
  });

  it("nao conta transacao descartada por status/kind", () => {
    const result = resolvePaymentGatewaySplit([
      tx({ gateway: "Pix (3% de desconto)", amountCents: 1000, kind: "sale" }),
      tx({ gateway: "Pix (3% de desconto)", amountCents: 9999, status: "failure" }),
      tx({ gateway: "Pix (3% de desconto)", amountCents: 9999, kind: "authorization" }),
    ]);

    expect(result).toEqual([
      expect.objectContaining({ gatewayRaw: "Pix (3% de desconto)", amountCents: 1000, transactionCount: 1 }),
    ]);
  });
});
