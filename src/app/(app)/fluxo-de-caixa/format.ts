import type { TransactionType } from "@/features/transactions/types";

export const TYPE_LABELS: Record<TransactionType, string> = {
  income: "Entrada",
  expense: "Saída",
  transfer: "Transferência",
};

export function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

// Dia de calendario de Brasilia, nunca o do fuso do processo (UTC na Vercel).
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(new Date(iso));
}

export function buildEntriesQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}
