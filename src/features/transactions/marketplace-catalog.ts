import { normalizeMarketplaceToken } from "./read-model-filters";

/**
 * Catalogo das abas da tela Marketplaces. Adicionar um marketplace e acrescentar
 * uma linha aqui -- o filtro de `financial_orders` casa `marketplace_key` de
 * forma generica, entao KPIs, listagem e export passam a aceitar a chave nova
 * sem outra mudanca.
 *
 * A `key` e o `marketplace_key` gravado na tabela materializada, nao o rotulo.
 * As chaves existentes saem de:
 *
 *   SELECT source_key, marketplace_key, count(*)
 *     FROM integration.financial_orders GROUP BY 1, 2 ORDER BY 3 DESC;
 *
 * Ordem por volume de pedidos (medido em 23/09/2026). O Anymarket nao tem aba:
 * e hub de integracao, e seus pedidos ja aparecem nas abas dos marketplaces de
 * destino e em "Todos".
 */
export const MARKETPLACE_TABS = [
  { key: "shopify", label: "Shopify" },
  { key: "mercado_livre", label: "Mercado Livre" },
  { key: "shopee", label: "Shopee" },
  { key: "netshoes", label: "Netshoes" },
  { key: "tiktok_shop", label: "TikTok Shop" },
  { key: "amazon_global_api", label: "Amazon" },
] as const;

export type MarketplaceKey = (typeof MARKETPLACE_TABS)[number]["key"];

export const ALL_MARKETPLACES = "todos";
export const DEFAULT_MARKETPLACE: MarketplaceKey = "shopify";

export type MarketplaceTab = MarketplaceKey | typeof ALL_MARKETPLACES;

// Links salvos com valores que a tela aceitava antes das abas.
const LEGACY_ALIASES: Record<string, MarketplaceKey> = {
  amazon: "amazon_global_api",
  tiktok: "tiktok_shop",
};

export function isMarketplaceKey(value: string): value is MarketplaceKey {
  return MARKETPLACE_TABS.some((tab) => tab.key === value);
}

/**
 * Resolve o `?marketplace=` da URL para uma aba. Valor ausente, desconhecido ou
 * `anymarket` cai no default; "todos"/"all" viram a aba sem filtro.
 */
export function resolveMarketplaceTab(raw: string | null | undefined): MarketplaceTab {
  if (!raw || !raw.trim()) return DEFAULT_MARKETPLACE;

  const token = normalizeMarketplaceToken(raw);
  if (token === null) return ALL_MARKETPLACES;

  if (isMarketplaceKey(token)) return token;
  return LEGACY_ALIASES[token] ?? DEFAULT_MARKETPLACE;
}

/** Rotulo do catalogo para um rotulo ou chave de marketplace; null se fora dele. */
export function findMarketplaceLabel(value: string): string | null {
  const token = normalizeMarketplaceToken(value);
  if (!token) return null;
  const key = isMarketplaceKey(token) ? token : LEGACY_ALIASES[token];
  return MARKETPLACE_TABS.find((tab) => tab.key === key)?.label ?? null;
}
