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

  if (/^[A-Z]/.test(value)) {
    return value;
  }

  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}
