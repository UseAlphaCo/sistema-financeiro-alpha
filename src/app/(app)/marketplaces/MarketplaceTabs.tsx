import {
  ALL_MARKETPLACES,
  MARKETPLACE_TABS,
  type MarketplaceTab,
} from "@/features/transactions/marketplace-catalog";

const TABS: Array<{ key: MarketplaceTab; label: string }> = [
  ...MARKETPLACE_TABS,
  { key: ALL_MARKETPLACES, label: "Todos" },
];

/**
 * Abas como links de navegacao (`aria-current`), nao `role="tablist"`: cada aba
 * e uma URL propria, recarregavel e compartilhavel, e o conteudo vem do
 * servidor. `hrefFor` decide o que a troca de aba preserva -- a pagina, nao.
 */
export default function MarketplaceTabs({
  active,
  hrefFor,
}: {
  active: MarketplaceTab;
  hrefFor: (marketplace: MarketplaceTab) => string;
}) {
  return (
    <nav aria-label="Marketplaces" className="mb-6 overflow-x-auto border-b border-gray-200">
      <ul className="-mb-px flex gap-1 text-sm">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <li key={tab.key} className="shrink-0">
              <a
                href={hrefFor(tab.key)}
                aria-current={isActive ? "page" : undefined}
                className={`block whitespace-nowrap border-b-2 px-3 py-2 ${
                  isActive
                    ? "border-gray-900 font-medium text-gray-900"
                    : "border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700"
                }`}
              >
                {tab.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
