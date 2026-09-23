import { findMarketplaceLabel } from "@/features/transactions/marketplace-catalog";

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  import: "Importação",
  shopify: "Shopify",
  anymarket: "Anymarket",
  mercado_livre: "Mercado Livre",
  mercadoLivre: "Mercado Livre",
  shopee: "Shopee",
  amazon: "Amazon",
};

export function formatOriginLabel(value: string): string {
  const direct = SOURCE_LABELS[value];
  if (direct) return direct;

  // `bySource` chega com o rotulo gravado pelo mapper ("Amazon Global Api");
  // o catalogo das abas e quem define como cada marketplace e chamado na tela.
  const catalog = findMarketplaceLabel(value);
  if (catalog) return catalog;

  if (/^[A-Z]/.test(value)) {
    return value;
  }

  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}
