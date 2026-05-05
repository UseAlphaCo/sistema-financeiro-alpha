export type UiFilterState = {
  periodDays: 30 | 60 | 90;
  marketplace: "all" | "shopify" | "mercado_livre" | "shopee" | "amazon";
};

export const initialUiFilterState: UiFilterState = {
  periodDays: 30,
  marketplace: "all",
};
