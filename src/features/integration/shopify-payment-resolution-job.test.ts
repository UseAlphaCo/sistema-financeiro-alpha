import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchTransactionsMock, replaceSplitMock, upsertResolutionMock } = vi.hoisted(() => ({
  fetchTransactionsMock: vi.fn(),
  replaceSplitMock: vi.fn(),
  upsertResolutionMock: vi.fn(),
}));

// So a ida a Admin API e' falsa. `resolveDominantPaymentMethod` e
// `resolvePaymentGatewaySplit` continuam REAIS de proposito: as duas saem do
// mesmo `buildGatewayTotals`, e e' essa convergencia que faz "nao ha transacao
// resolvivel" e "o rateio seria vazio" serem a mesma condicao. Mockar as duas
// esconderia justamente o que este teste precisa provar.
vi.mock("./shopify-order-transactions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shopify-order-transactions")>()),
  fetchShopifyOrderTransactions: fetchTransactionsMock,
}));

vi.mock("./shopify-payment-resolution-repository", () => ({
  ensureShopifyPaymentGatewaySplitTable: vi.fn(),
  ensureShopifyPaymentResolutionTable: vi.fn(),
  findUnresolvedShopifyOrders: vi.fn().mockResolvedValue([]),
  replaceShopifyPaymentGatewaySplit: replaceSplitMock,
  upsertShopifyPaymentResolution: upsertResolutionMock,
}));

import { resolveShopifyOrderById } from "./shopify-payment-resolution-job";

const LOJA = "exemplo.myshopify.com";
const TOKEN = "shpat_token_de_teste";
const PEDIDO = "7592752316641";

describe("resolveShopifyOrderById", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * O caso que motivou o parametro.
   *
   * `replaceShopifyPaymentGatewaySplit(id, [])` apaga TODAS as pernas do pedido
   * — contrato deliberado do repositorio, com teste proprio. Chamar isso depois
   * de uma resposta vazia da Admin API zerava o ledger de um pedido que a
   * reconciliacao so estava tocando porque o tenderTransactions REPORTOU
   * dinheiro nele. O conserto deixava o dado pior do que antes.
   */
  it("nao apaga o rateio quando a Admin API devolve zero transacoes", async () => {
    fetchTransactionsMock.mockResolvedValue([]);

    const outcome = await resolveShopifyOrderById(LOJA, TOKEN, PEDIDO);

    expect(outcome).toBe("sem_transacao");
    expect(replaceSplitMock).not.toHaveBeenCalled();

    // O upsert continua acontecendo: sem ele o pedido nunca sai de
    // findUnresolvedShopifyOrders e volta a ser candidato a cada rodada.
    expect(upsertResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ external_order_id: PEDIDO, dominant_gateway_raw: null })
    );
  });

  // Segundo caminho para o mesmo ramo, e igualmente real: o pedido TEM
  // transacao, mas nenhuma que conte (estorno, falha, kind fora de
  // sale/capture/change). `buildGatewayTotals` devolve vazio do mesmo jeito.
  it("nao apaga o rateio quando nenhuma transacao e aproveitavel", async () => {
    fetchTransactionsMock.mockResolvedValue([
      { gateway: "appmax", kind: "refund", status: "success", amountCents: 19_702, processedAt: null },
      { gateway: "appmax", kind: "sale", status: "failure", amountCents: 19_702, processedAt: null },
    ]);

    const outcome = await resolveShopifyOrderById(LOJA, TOKEN, PEDIDO);

    expect(outcome).toBe("sem_transacao");
    expect(replaceSplitMock).not.toHaveBeenCalled();
  });

  // O job precisa da limpeza: ele alcanca pedido JA resolvido cujo
  // `mirror_updated_at` mudou, e nesse caso a perna velha tem de sair, senao
  // soma em dobro na janela.
  it("apaga o rateio quando o chamador pede explicitamente", async () => {
    fetchTransactionsMock.mockResolvedValue([]);

    const outcome = await resolveShopifyOrderById(LOJA, TOKEN, PEDIDO, {
      clearSplitWhenEmpty: true,
    });

    expect(outcome).toBe("sem_transacao");
    expect(replaceSplitMock).toHaveBeenCalledWith(PEDIDO, []);
  });

  it("grava gateway titular e rateio quando ha transacao aproveitavel", async () => {
    fetchTransactionsMock.mockResolvedValue([
      {
        gateway: "Pix (3% de desconto)",
        kind: "sale",
        status: "success",
        amountCents: 10_000,
        processedAt: "2026-09-20T12:00:00Z",
      },
      {
        gateway: "shopify_store_credit",
        kind: "sale",
        status: "success",
        amountCents: 4_000,
        processedAt: "2026-09-20T12:00:00Z",
      },
    ]);

    const outcome = await resolveShopifyOrderById(LOJA, TOKEN, PEDIDO);

    expect(outcome).toBe("resolvido");

    // Titular e' o de maior valor, nao o primeiro da lista.
    expect(upsertResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        external_order_id: PEDIDO,
        dominant_gateway_raw: "Pix (3% de desconto)",
        dominant_amount_cents: 10_000,
        total_amount_cents: 14_000,
      })
    );

    expect(replaceSplitMock).toHaveBeenCalledWith(PEDIDO, [
      expect.objectContaining({ gatewayRaw: "Pix (3% de desconto)", amountCents: 10_000 }),
      expect.objectContaining({ gatewayRaw: "shopify_store_credit", amountCents: 4_000 }),
    ]);
  });
});
