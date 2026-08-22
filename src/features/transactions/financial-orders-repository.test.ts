// O vitest nao carrega .env por conta propria: sem isto, `conn` fica undefined
// e o teste toma o caminho de skip em silencio -- o que acontece hoje com
// worker-job-repository.test.ts, que parece verde sem nunca tocar o banco.
import "dotenv/config";

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  closePool,
  deleteFinancialOrders,
  ensureFinancialOrdersTable,
  escapeLikeTerm,
  getMaterializedLag,
  upsertFinancialOrders,
  type MaterializedOrder,
} from "./financial-orders-repository";

describe("escapeLikeTerm", () => {
  it("escapa os curingas do LIKE", () => {
    // O caminho legado usa String.includes, onde % e _ sao caracteres comuns.
    // Sem escapar, buscar "50%" viraria "comeca com 50" no SQL e os dois
    // caminhos devolveriam conjuntos diferentes, sem erro nenhum.
    expect(escapeLikeTerm("50%")).toBe("50\\%");
    expect(escapeLikeTerm("a_b")).toBe("a\\_b");
  });

  it("escapa a barra ANTES dos curingas", () => {
    // Ordem importa: escapar % antes de \ faria o proprio escape ser escapado
    // depois, e o termo procurado deixaria de ser o digitado.
    expect(escapeLikeTerm("a\\b")).toBe("a\\\\b");
    expect(escapeLikeTerm("100\\%")).toBe("100\\\\\\%");
  });

  it("nao mexe em termo comum", () => {
    expect(escapeLikeTerm("#1439 shopify")).toBe("#1439 shopify");
  });
});

const conn = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

// Fonte inexistente de proposito: o teste roda contra o banco real (mesmo
// padrao de worker-job-repository.test.ts) e nao pode se confundir com pedido
// de verdade nem sobreviver ao fim do teste.
const TEST_SOURCE = "vitest-financial-orders";

function order(overrides: Partial<MaterializedOrder> & { orderKey: string }): MaterializedOrder {
  return {
    source: TEST_SOURCE,
    mirrorRowId: randomUUID(),
    externalId: overrides.orderKey,
    occurredAt: "2026-08-10T12:00:00.000Z",
    marketplace: "Shopify",
    marketplaceKey: "shopify",
    sourceKey: "shopify",
    sourceBucket: "shopify",
    orderNumber: "#1",
    description: "Pedido #1",
    paymentMethodRaw: "pix",
    paymentMethodNormalized: "pix",
    amountCents: 10_000,
    shippingCents: 0,
    discountCents: 0,
    taxCents: 0,
    feeCents: 0,
    liquidCents: 10_000,
    currency: "BRL",
    type: "income",
    txSource: "webhook",
    status: "approved",
    receivedAt: "2026-08-10T12:05:00.000Z",
    sourceUpdatedAt: null,
    searchText: "pedido #1 shopify",
    contentHash: "hash-1",
    ...overrides,
  };
}

describe("financial-orders-repository (integration)", () => {
  if (!conn) {
    it("pula quando nao ha CORE_DB_URL nem DATABASE_URL", () => {
      expect(true).toBe(true);
    });
    return;
  }

  it("grava, respeita o guard de content_hash e apaga", async () => {
    await ensureFinancialOrdersTable();

    const keyA = `A-${randomUUID()}`;
    const keyB = `B-${randomUUID()}`;
    const keys = [
      { source: TEST_SOURCE, orderKey: keyA },
      { source: TEST_SOURCE, orderKey: keyB },
    ];

    try {
      expect(await upsertFinancialOrders([order({ orderKey: keyA }), order({ orderKey: keyB })])).toBe(2);

      // Mesmo content_hash: o UPSERT nao pode reescrever. E o que preserva HOT e
      // evita gerar tupla morta a cada execucao do job diario.
      expect(await upsertFinancialOrders([order({ orderKey: keyA })])).toBe(0);

      // Hash diferente: reescreve.
      expect(
        await upsertFinancialOrders([order({ orderKey: keyA, contentHash: "hash-2", amountCents: 20_000 })])
      ).toBe(1);

      const lag = await getMaterializedLag();
      expect(lag).not.toBeNull();
      expect(lag?.total).toBeGreaterThanOrEqual(2);
      // `total` vem de count(*), que e bigint: sem Number() viria string do
      // driver `pg` e qualquer comparacao numerica na tela sairia errada.
      expect(typeof lag?.total).toBe("number");
      expect(lag?.maxMaterializedAt).not.toBeNull();
    } finally {
      expect(await deleteFinancialOrders(keys)).toBe(2);
      await closePool();
    }
  });
});
