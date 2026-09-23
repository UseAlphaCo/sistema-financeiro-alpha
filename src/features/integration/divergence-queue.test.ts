import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A camada que a rota chama, com o repositorio isolado: o que se testa aqui e'
 * validacao, autoria e a traducao de "nao atualizou" em 404 ou 409. O SQL tem
 * teste proprio, contra o banco, em shopify-reconciliation-repository.test.ts.
 */

const repo = vi.hoisted(() => ({
  acceptDivergence: vi.fn(),
  countDivergencesByStatus: vi.fn(),
  ensureShopifyReconciliationTable: vi.fn(),
  getDivergence: vi.fn(),
  listOpenDivergences: vi.fn(),
  requeueDivergence: vi.fn(),
  STATUS_EM_ABERTO: ["pendente", "persistente", "sem_correcao"],
}));

vi.mock("./shopify-reconciliation-repository", () => repo);
// O orquestrador puxa Shopify e banco; daqui so interessa o teto.
vi.mock("./shopify-reconciliation", () => ({ MAX_RETRY_ATTEMPTS: 5 }));

const { applyDivergenceAction } = await import("./divergence-queue");

const ATOR = { email: "financeiro@exemplo.com" };
const LINHA = { externalOrderId: "7597348782305", status: "aceito" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyDivergenceAction", () => {
  it("recusa id que nao e' de pedido da Shopify, antes de tocar o banco", async () => {
    await expect(applyDivergenceAction("1; drop table", { action: "reprocessar" }, ATOR)).rejects.toMatchObject({
      status: 400,
    });
    expect(repo.requeueDivergence).not.toHaveBeenCalled();
  });

  it("recusa acao desconhecida e nota longa demais", async () => {
    await expect(applyDivergenceAction("123", { action: "apagar" }, ATOR)).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      applyDivergenceAction("123", { action: "aceitar", note: "x".repeat(501) }, ATOR)
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reprocessar passa o teto da rodada ao repositorio", async () => {
    repo.requeueDivergence.mockResolvedValue({ ...LINHA, status: "pendente" });

    await applyDivergenceAction("123", { action: "reprocessar" }, ATOR);

    expect(repo.requeueDivergence).toHaveBeenCalledWith("123", 5);
  });

  it("aceitar grava o autor da sessao e a nota aparada", async () => {
    repo.acceptDivergence.mockResolvedValue(LINHA);

    await applyDivergenceAction("123", { action: "aceitar", note: "  estorno no gateway  " }, ATOR);

    expect(repo.acceptDivergence).toHaveBeenCalledWith("123", {
      acceptedBy: "financeiro@exemplo.com",
      note: "estorno no gateway",
    });
  });

  it("nota vazia vira null, nao string vazia no historico", async () => {
    repo.acceptDivergence.mockResolvedValue(LINHA);

    await applyDivergenceAction("123", { action: "aceitar", note: "   " }, ATOR);

    expect(repo.acceptDivergence).toHaveBeenCalledWith("123", {
      acceptedBy: "financeiro@exemplo.com",
      note: null,
    });
  });

  it("pedido inexistente e' 404", async () => {
    repo.requeueDivergence.mockResolvedValue(null);
    repo.getDivergence.mockResolvedValue(null);

    await expect(applyDivergenceAction("123", { action: "reprocessar" }, ATOR)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("divergencia ja fechada e' 409, para a tela recarregar em vez de repetir", async () => {
    repo.acceptDivergence.mockResolvedValue(null);
    repo.getDivergence.mockResolvedValue({ ...LINHA, status: "corrigido" });

    await expect(applyDivergenceAction("123", { action: "aceitar" }, ATOR)).rejects.toMatchObject({
      status: 409,
      code: "ALREADY_CLOSED",
    });
  });
});
