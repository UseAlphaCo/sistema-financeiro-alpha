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
// de verdade.
const TEST_SOURCE = "vitest-financial-orders";

/**
 * Chaves FIXAS, nao aleatorias.
 *
 * Com chave aleatoria, uma execucao morta antes do `finally` (timeout do
 * vitest, Ctrl-C) deixa residuo que nenhuma execucao futura sabe apagar --
 * aconteceu em 2026-08-22 e duas linhas de teste de R$ 100 marcadas como
 * Shopify ficaram na tabela de producao, visiveis nas telas. Com chave fixa, a
 * limpeza do inicio remove o residuo de qualquer execucao anterior.
 */
const KEY_A = "vitest-A";
const KEY_B = "vitest-B";

/**
 * Data do pedido de teste, RELATIVA e nao fixa.
 *
 * getMaterializedLag recorta por occurred_at (FRESHNESS_WINDOW_DAYS), entao uma
 * data fixa sai da janela conforme o tempo passa e o teste deixaria de exercer o
 * que pretende -- em silencio, porque a assercao passaria a medir dado de
 * producao em vez do que este teste gravou.
 *
 * D-1 e nao "agora": o pedido de teste fica dentro da janela de frescor sem
 * aparecer no dia corrente das telas caso uma execucao morra antes do `finally`.
 */
const TEST_OCCURRED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function order(overrides: Partial<MaterializedOrder> & { orderKey: string }): MaterializedOrder {
  return {
    source: TEST_SOURCE,
    mirrorRowId: randomUUID(),
    externalId: overrides.orderKey,
    occurredAt: TEST_OCCURRED_AT,
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
    receivedAt: TEST_OCCURRED_AT,
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

  // 30 s, nao os 5 s do default: sao seis idas e voltas a um Postgres remoto
  // (us-east-1) e o teste roda em paralelo com o que mais estiver usando o link.
  // Falhar por contencao de banda nao e informacao sobre o codigo.
  it("grava, respeita o guard de content_hash e apaga", { timeout: 30_000 }, async () => {
    await ensureFinancialOrdersTable();

    const keyA = KEY_A;
    const keyB = KEY_B;
    const keys = [
      { source: TEST_SOURCE, orderKey: keyA },
      { source: TEST_SOURCE, orderKey: keyB },
    ];

    // Limpeza de entrada: apaga residuo de execucao anterior interrompida.
    await deleteFinancialOrders(keys);

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
      // As duas linhas gravadas acima estao em D-1, dentro da janela de frescor.
      expect(lag?.ordersInWindow).toBeGreaterThanOrEqual(2);
      // `ordersInWindow` vem de count(*), que e bigint: sem Number() viria
      // string do driver `pg` e qualquer comparacao numerica na tela sairia
      // errada.
      expect(typeof lag?.ordersInWindow).toBe("number");
      expect(lag?.maxMaterializedAt).not.toBeNull();
      // O teto do read model tem de alcancar o que acabou de ser gravado --
      // e este campo, e nao maxMaterializedAt, que a UI usa para decidir se um
      // periodo pedido ja tem resposta.
      expect(lag?.maxOccurredAt).not.toBeNull();
      expect(new Date(lag!.maxOccurredAt!).getTime()).toBeGreaterThanOrEqual(
        new Date(TEST_OCCURRED_AT).getTime()
      );
    } finally {
      expect(await deleteFinancialOrders(keys)).toBe(2);
      await closePool();
    }
  });
});
