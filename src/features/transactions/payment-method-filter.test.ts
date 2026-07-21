import { describe, expect, it } from "vitest";

import {
  classifyPaymentMethod,
  paymentRawMatchesMethod,
  transactionMatchesPaymentMethod,
} from "@/features/transactions/payment-method-filter";

describe("payment-method-filter", () => {
  it("encontra pix em forma composta", () => {
    expect(paymentRawMatchesMethod("Crédito em loja | Pix | Starkbank", "pix")).toBe(true);
  });

  it("encontra credito em loja em forma composta", () => {
    expect(paymentRawMatchesMethod("Crédito em loja | Pix | Starkbank", "store_credit")).toBe(true);
  });

  it("mantem compatibilidade por normalized exato", () => {
    expect(
      transactionMatchesPaymentMethod(
        {
          paymentMethodNormalized: "pix",
          paymentMethodRaw: null,
        },
        "pix"
      )
    ).toBe(true);
  });

  it("nao gera falso positivo quando forma nao existe", () => {
    expect(
      transactionMatchesPaymentMethod(
        {
          paymentMethodNormalized: "store_credit",
          paymentMethodRaw: "Crédito em loja | Pix | Starkbank",
        },
        "boleto"
      )
    ).toBe(false);
  });

  describe("classifyPaymentMethod", () => {
    it("classifica appmax como credit_card", () => {
      expect(classifyPaymentMethod("Appmax - Cartão de Crédito")).toBe("credit_card");
    });

    it("classifica pix isolado", () => {
      expect(classifyPaymentMethod("Pix (3% de desconto)")).toBe("pix");
    });

    it("prioriza store_credit quando combinado com pix (pedido split)", () => {
      expect(classifyPaymentMethod("Pix | Shopify Store Credit")).toBe("store_credit");
    });

    it("retorna other para valor vazio ou nulo", () => {
      expect(classifyPaymentMethod(null)).toBe("other");
      expect(classifyPaymentMethod("")).toBe("other");
      expect(classifyPaymentMethod("   ")).toBe("other");
    });

    it("retorna other para valor nao reconhecido", () => {
      expect(classifyPaymentMethod("gateway-desconhecido-xyz")).toBe("other");
    });
  });
});

