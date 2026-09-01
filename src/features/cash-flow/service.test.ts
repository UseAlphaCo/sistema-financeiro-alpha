import { describe, expect, it } from "vitest";

import { resolveCashFlowDateRange, summarizeTransactions } from "@/features/cash-flow/service";
import type { ShopifyGatewayPayment } from "@/features/transactions/read-model";

type SummarizeItem = Parameters<typeof summarizeTransactions>[0][number];

function incomeItem(overrides: Partial<SummarizeItem> = {}): SummarizeItem {
  return {
    marketplace: "Shopify",
    externalSource: "shopify",
    source: "shopify",
    type: "income",
    paymentMethodNormalized: "credit_card",
    amountCents: 10_000,
    discountCents: 0,
    shippingCents: 0,
    taxCents: 0,
    feeCents: 0,
    ...overrides,
  };
}

const NOW = new Date("2026-07-22T15:00:00Z");

/**
 * As asseveracoes sao sobre o INSTANTE (toISOString), nunca sobre getDate() /
 * getMonth().
 *
 * Os getters locais resolvem no fuso do processo, entao passavam tanto com o
 * codigo certo quanto com o errado -- davam confianca sem provar nada. E o
 * defeito que estes testes existem para pegar so aparece quando o fuso do
 * processo muda: em UTC (a Vercel) o dia 22/05 virava
 * 2026-05-22T00:00:00Z, tres horas antes do inicio real do dia em Brasilia.
 *
 * 03:00Z = 00:00-03 e 02:59:59.999Z do dia seguinte = 23:59:59.999-03.
 */
describe("resolveCashFlowDateRange", () => {
  it("usa a data como range de 1 dia quando so startDate vem preenchido", () => {
    const { start, end } = resolveCashFlowDateRange({ startDate: "2026-05-22" }, NOW);

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("usa a data como range de 1 dia quando so endDate vem preenchido", () => {
    const { start, end } = resolveCashFlowDateRange({ endDate: "2026-05-22" }, NOW);

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("nao ignora startDate mesmo com preset default presente (bug do filtro parcial)", () => {
    // Cenario do print: form envia preset="yesterday" (hidden field default)
    // junto com startDate preenchido e endDate vazio — startDate deve vencer.
    const { start, end } = resolveCashFlowDateRange(
      { preset: "yesterday", startDate: "2026-05-22" },
      NOW
    );

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("usa startDate e endDate quando ambos vem preenchidos", () => {
    const { start, end } = resolveCashFlowDateRange(
      { startDate: "2026-05-20", endDate: "2026-05-22" },
      NOW
    );

    expect(start.toISOString()).toBe("2026-05-20T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("cai no preset apenas quando nenhuma data customizada vem preenchida", () => {
    const { start, end } = resolveCashFlowDateRange({ preset: "yesterday" }, NOW);

    // "Ontem" em relacao a NOW (22/07 12:00 em Brasilia) e 21/07.
    expect(start.toISOString()).toBe("2026-07-21T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-22T02:59:59.999Z");
  });

  it("resolve o dia de Brasilia, e nao o dia UTC, perto da virada", () => {
    // 2026-07-23T01:00:00Z ainda e 22/07 22:00 em Brasilia. O dia UTC ja virou;
    // o dia do negocio, nao. "Ontem" tem que ser 21/07, nao 22/07.
    const quaseMeiaNoiteUtc = new Date("2026-07-23T01:00:00Z");
    const { start, end } = resolveCashFlowDateRange({ preset: "yesterday" }, quaseMeiaNoiteUtc);

    expect(start.toISOString()).toBe("2026-07-21T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-22T02:59:59.999Z");
  });

  it("aceita ISO completo alem de YYYY-MM-DD", () => {
    // O schema de actions.ts permite as duas formas. A implementacao antiga
    // lancava para ISO completo: Number("22T00:00:00.000Z") = NaN.
    const { start, end } = resolveCashFlowDateRange(
      { startDate: "2026-05-22T10:00:00.000Z", endDate: "2026-05-22T10:00:00.000Z" },
      NOW
    );

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });
});

/**
 * Troca de base da Shopify: de "pedidos pagos" para "pagamentos processados".
 *
 * Ver docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md. Com o ledger de rateio
 * presente, a Shopify passa a reproduzir o relatorio "Pagamentos brutos por
 * gateway" -- cada perna do pagamento com o seu valor e a sua data -- enquanto
 * as demais origens continuam somando pedidos de integration.financial_orders.
 */
describe("summarizeTransactions — base de pagamentos da Shopify", () => {
  it("sem o ledger (parametro omitido): pedido Shopify conta como antes", () => {
    const result = summarizeTransactions([incomeItem({ amountCents: 10_000, paymentMethodNormalized: "pix" })]);

    expect(result.totalIncomeCents).toBe(10_000);
    expect(result.byPaymentMethod).toEqual([{ paymentMethod: "pix", grossCents: 10_000, transactionCount: 1 }]);
    expect(result.bySource).toEqual([
      { source: "Shopify", grossCents: 10_000, expenseCents: 0, transactionCount: 1, basis: "orders" },
    ]);
  });

  it("com o ledger: a Shopify vem do rateio por gateway, e o pedido nao e somado duas vezes", () => {
    // Um pedido de R$ 100,00 dividido entre Pix e credito na loja. O read model
    // atribui os R$ 100,00 inteiros ao gateway titular; o ledger separa.
    const pagamentos: ShopifyGatewayPayment[] = [
      { gatewayRaw: "Pix (3% de desconto)", amountCents: 6_000, transactionCount: 1 },
      { gatewayRaw: "shopify_store_credit", amountCents: 4_000, transactionCount: 1 },
    ];

    const result = summarizeTransactions(
      [incomeItem({ amountCents: 10_000, paymentMethodNormalized: "pix" })],
      pagamentos
    );

    const byMethod = new Map(result.byPaymentMethod.map((row) => [row.paymentMethod, row]));
    expect(byMethod.get("pix")).toEqual({ paymentMethod: "pix", grossCents: 6_000, transactionCount: 1 });
    expect(byMethod.get("store_credit")).toEqual({
      paymentMethod: "store_credit",
      grossCents: 4_000,
      transactionCount: 1,
    });

    expect(result.totalIncomeCents).toBe(10_000);
    expect(result.bySource).toEqual([
      { source: "Shopify", grossCents: 10_000, expenseCents: 0, transactionCount: 2, basis: "payments" },
    ]);
  });

  it("conta TRANSACOES, nao pedidos: dois pagamentos no mesmo gateway somam 2", () => {
    const result = summarizeTransactions([incomeItem({ amountCents: 10_000 })], [
      { gatewayRaw: "Appmax - Cartão de Crédito", amountCents: 10_000, transactionCount: 2 },
    ]);

    expect(result.bySource[0].transactionCount).toBe(2);
    expect(result.byPaymentMethod).toEqual([
      { paymentMethod: "credit_card", grossCents: 10_000, transactionCount: 2 },
    ]);
  });

  it("as outras origens nao mudam de base quando o ledger da Shopify esta presente", () => {
    const result = summarizeTransactions(
      [
        incomeItem({ amountCents: 10_000 }),
        incomeItem({
          marketplace: "Mercado Livre",
          externalSource: "anymarket",
          source: "anymarket",
          amountCents: 7_000,
          paymentMethodNormalized: "credit_card",
        }),
      ],
      [{ gatewayRaw: "Pix (3% de desconto)", amountCents: 11_000, transactionCount: 3 }]
    );

    const bySource = new Map(result.bySource.map((row) => [row.source, row]));
    expect(bySource.get("Mercado Livre")).toEqual({
      source: "Mercado Livre",
      grossCents: 7_000,
      expenseCents: 0,
      transactionCount: 1,
      basis: "orders",
    });
    // Shopify pelo ledger (11.000), Mercado Livre pelo pedido (7.000).
    expect(bySource.get("Shopify")?.grossCents).toBe(11_000);
    expect(result.totalIncomeCents).toBe(18_000);
  });

  it("ordena bySource pelo maior faturamento, para a Shopify nao cair no fim da tabela", () => {
    const result = summarizeTransactions(
      [
        incomeItem({
          marketplace: "Mercado Livre",
          externalSource: "anymarket",
          source: "anymarket",
          amountCents: 7_000,
        }),
        incomeItem({ amountCents: 1_000 }),
      ],
      [{ gatewayRaw: "Pix (3% de desconto)", amountCents: 90_000, transactionCount: 1 }]
    );

    expect(result.bySource.map((row) => row.source)).toEqual(["Shopify", "Mercado Livre"]);
  });

  // Ledger vazio quase sempre significa "o job de resolucao ainda nao cobriu
  // esta janela", nao "nao houve pagamento". Trocar de base aqui apagaria a
  // Shopify da tela, e vazio na tela le-se como "nao vendemos nada".
  it("ledger vazio cai na base de pedidos em vez de zerar a Shopify", () => {
    const result = summarizeTransactions([incomeItem({ amountCents: 10_000 })], []);

    expect(result.bySource).toEqual([
      { source: "Shopify", grossCents: 10_000, expenseCents: 0, transactionCount: 1, basis: "orders" },
    ]);
    expect(result.totalIncomeCents).toBe(10_000);
  });
});
