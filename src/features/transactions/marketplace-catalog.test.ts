import { describe, expect, it } from "vitest";

import {
  ALL_MARKETPLACES,
  DEFAULT_MARKETPLACE,
  MARKETPLACE_TABS,
  findMarketplaceLabel,
  resolveMarketplaceTab,
} from "@/features/transactions/marketplace-catalog";
import { normalizeMarketplaceToken } from "@/features/transactions/read-model-filters";

describe("MARKETPLACE_TABS", () => {
  // O filtro compara o valor da URL, normalizado, com `marketplace_key`, que e
  // gravado pelo mesmo normalizador. Uma chave que o normalizador reescreve
  // nunca casaria com linha nenhuma, e a aba mostraria zero em silencio.
  it("toda chave e ponto fixo do normalizador", () => {
    for (const tab of MARKETPLACE_TABS) {
      expect(normalizeMarketplaceToken(tab.key)).toBe(tab.key);
    }
  });

  it("nao repete chave", () => {
    const keys = MARKETPLACE_TABS.map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("resolveMarketplaceTab", () => {
  it("ausente ou vazio cai no default", () => {
    expect(resolveMarketplaceTab(undefined)).toBe(DEFAULT_MARKETPLACE);
    expect(resolveMarketplaceTab("")).toBe(DEFAULT_MARKETPLACE);
    expect(resolveMarketplaceTab("   ")).toBe(DEFAULT_MARKETPLACE);
  });

  it("todos e all viram a aba sem filtro", () => {
    expect(resolveMarketplaceTab("todos")).toBe(ALL_MARKETPLACES);
    expect(resolveMarketplaceTab("all")).toBe(ALL_MARKETPLACES);
  });

  it("aceita chave do catalogo e variacoes de grafia", () => {
    expect(resolveMarketplaceTab("netshoes")).toBe("netshoes");
    expect(resolveMarketplaceTab("Mercado Livre")).toBe("mercado_livre");
    expect(resolveMarketplaceTab("mercadolivre")).toBe("mercado_livre");
    expect(resolveMarketplaceTab("TikTok-Shop")).toBe("tiktok_shop");
  });

  it("links antigos de amazon resolvem para a chave gravada", () => {
    expect(resolveMarketplaceTab("amazon")).toBe("amazon_global_api");
  });

  it("anymarket e desconhecido caem no default", () => {
    expect(resolveMarketplaceTab("anymarket")).toBe(DEFAULT_MARKETPLACE);
    expect(resolveMarketplaceTab("magalu")).toBe(DEFAULT_MARKETPLACE);
  });
});

describe("findMarketplaceLabel", () => {
  it("traduz o rotulo gravado pelo mapper para o do catalogo", () => {
    expect(findMarketplaceLabel("Amazon Global Api")).toBe("Amazon");
    expect(findMarketplaceLabel("Tiktok Shop")).toBe("TikTok Shop");
  });

  it("devolve null fora do catalogo", () => {
    expect(findMarketplaceLabel("Magalu")).toBeNull();
    expect(findMarketplaceLabel("todos")).toBeNull();
  });
});
