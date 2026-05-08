import { describe, expect, it } from "vitest";

import {
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
});
