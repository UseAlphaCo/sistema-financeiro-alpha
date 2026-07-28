"use client";

import { useEffect, useMemo, useState } from "react";

import { formatPaymentMethod, parseOrderNumber } from "@/features/transactions/format";
import type { FinancialTransaction } from "@/features/transactions/types";

type Pagination = {
  page: number;
  limit: number;
  total: number;
  hasNext: boolean;
};

type QueryState = {
  preset?: string;
  startDate?: string;
  endDate?: string;
  marketplace?: string;
  paymentMethod?: string;
  limit?: string;
};

type ColumnId =
  | "marketplace"
  | "orderNumber"
  | "occurredAt"
  | "paymentMethod"
  | "shipping"
  | "discount"
  | "taxes"
  | "amount";

type ColumnConfig = {
  id: ColumnId;
  label: string;
  align: "left" | "right";
};

const COLUMN_STORAGE_KEY = "fluxo-de-caixa-visible-columns";

const COLUMN_CONFIGS: ColumnConfig[] = [
  { id: "marketplace", label: "Marketplace", align: "left" },
  { id: "orderNumber", label: "Número do pedido", align: "left" },
  { id: "occurredAt", label: "Data", align: "left" },
  { id: "paymentMethod", label: "Forma de pagamento", align: "left" },
  { id: "shipping", label: "Entrega", align: "right" },
  { id: "discount", label: "Descontos", align: "right" },
  { id: "taxes", label: "Taxas", align: "right" },
  { id: "amount", label: "Valor", align: "right" },
];

const DEFAULT_VISIBILITY: Record<ColumnId, boolean> = {
  marketplace: true,
  orderNumber: true,
  occurredAt: true,
  paymentMethod: true,
  shipping: true,
  discount: false,
  taxes: true,
  amount: true,
};

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(iso));
}

function buildFlowQuery(params: QueryState & { page: number }): string {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    search.set(key, String(value));
  }

  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function getPageCount(pagination: Pagination): number {
  return Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.limit)));
}

export default function FluxoDeCaixaTable({
  items,
  pagination,
  query,
}: {
  items: FinancialTransaction[];
  pagination: Pagination;
  query: QueryState;
}) {
  const [visibility, setVisibility] = useState<Record<ColumnId, boolean>>(() => {
    if (typeof window === "undefined") {
      return DEFAULT_VISIBILITY;
    }

    try {
      const stored = window.localStorage.getItem(COLUMN_STORAGE_KEY);
      if (!stored) {
        return DEFAULT_VISIBILITY;
      }

      const parsed = JSON.parse(stored) as Partial<Record<ColumnId, boolean>>;
      return { ...DEFAULT_VISIBILITY, ...parsed };
    } catch {
      return DEFAULT_VISIBILITY;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(visibility));
    } catch {
      // Persistência local é opcional.
    }
  }, [visibility]);

  const visibleColumns = useMemo(
    () => COLUMN_CONFIGS.filter((column) => visibility[column.id]),
    [visibility]
  );

  const pageCount = getPageCount(pagination);

  const totals = items.reduce(
    (acc, item) => {
      acc.shipping += item.shippingCents ?? 0;
      acc.discount += item.discountCents ?? 0;
      acc.taxes += (item.taxCents ?? 0) + (item.feeCents ?? 0);
      acc.amount += item.amountCents;
      return acc;
    },
    { shipping: 0, discount: 0, taxes: 0, amount: 0 }
  );

  const pageLink = (page: number) =>
    `/fluxo-de-caixa${buildFlowQuery({
      ...query,
      page,
    })}`;

  function toggleColumn(columnId: ColumnId) {
    setVisibility((current) => ({
      ...current,
      [columnId]: !current[columnId],
    }));
  }

  function restoreDefault() {
    setVisibility(DEFAULT_VISIBILITY);
  }

  return (
    <div className="mt-8" suppressHydrationWarning>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Entradas de marketplaces</h2>
        <details className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600">
          <summary className="cursor-pointer list-none font-medium text-gray-700">Gerenciar colunas</summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {COLUMN_CONFIGS.map((column) => (
              <label key={column.id} className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5">
                <input
                  type="checkbox"
                  checked={visibility[column.id]}
                  onChange={() => toggleColumn(column.id)}
                />
                <span>{column.label}</span>
              </label>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              onClick={restoreDefault}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
            >
              Restaurar padrão
            </button>
          </div>
        </details>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500">
          Nenhuma entrada de marketplace encontrada com os filtros atuais.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                {visibleColumns.map((column) => (
                  <th
                    key={column.id}
                    className={`px-4 py-3 ${column.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  {visibility.marketplace && <td className="whitespace-nowrap px-4 py-3 text-gray-700 capitalize">{item.marketplace ?? item.externalSource ?? "—"}</td>}
                  {visibility.orderNumber && <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900">{parseOrderNumber(item)}</td>}
                  {visibility.occurredAt && <td className="whitespace-nowrap px-4 py-3 text-gray-600">{formatDate(item.occurredAt)}</td>}
                  {visibility.paymentMethod && <td className="whitespace-nowrap px-4 py-3 text-gray-600">{formatPaymentMethod(item)}</td>}
                  {visibility.shipping && <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600">{formatBRL(item.shippingCents ?? 0)}</td>}
                  {visibility.discount && <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600">{formatBRL(item.discountCents ?? 0)}</td>}
                  {visibility.taxes && <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600">{formatBRL((item.taxCents ?? 0) + (item.feeCents ?? 0))}</td>}
                  {visibility.amount && <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">{formatBRL(item.amountCents)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50">
              <tr>
                {visibleColumns.map((column, index) => {
                  if (index === 0) {
                    return (
                      <td
                        key={column.id}
                        className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-600"
                      >
                        Total da página
                      </td>
                    );
                  }

                  if (column.id === "shipping") {
                    return (
                      <td key={column.id} className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-700">
                        {formatBRL(totals.shipping)}
                      </td>
                    );
                  }

                  if (column.id === "discount") {
                    return (
                      <td key={column.id} className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-700">
                        {formatBRL(totals.discount)}
                      </td>
                    );
                  }

                  if (column.id === "taxes") {
                    return (
                      <td key={column.id} className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-700">
                        {formatBRL(totals.taxes)}
                      </td>
                    );
                  }

                  if (column.id === "amount") {
                    return (
                      <td key={column.id} className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-900">
                        {formatBRL(totals.amount)}
                      </td>
                    );
                  }

                  return <td key={column.id} className="px-4 py-3 text-sm text-gray-400" />;
                })}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
        <span>
          Exibindo {items.length} registros na página {pagination.page}
        </span>
        <div className="flex gap-2">
          <a
            href={pageLink(1)}
            className={`rounded border px-2 py-1 ${pagination.page > 1 ? "border-gray-300 text-gray-700 hover:bg-gray-50" : "pointer-events-none border-gray-200 text-gray-300"}`}
          >
            Primeira
          </a>
          <a
            href={pageLink(Math.max(1, pagination.page - 1))}
            className={`rounded border px-2 py-1 ${pagination.page > 1 ? "border-gray-300 text-gray-700 hover:bg-gray-50" : "pointer-events-none border-gray-200 text-gray-300"}`}
          >
            Anterior
          </a>
          <a
            href={pageLink(Math.min(pageCount, pagination.page + 1))}
            className={`rounded border px-2 py-1 ${pagination.hasNext ? "border-gray-300 text-gray-700 hover:bg-gray-50" : "pointer-events-none border-gray-200 text-gray-300"}`}
          >
            Próxima
          </a>
          <a
            href={pageLink(pageCount)}
            className={`rounded border px-2 py-1 ${pagination.page < pageCount ? "border-gray-300 text-gray-700 hover:bg-gray-50" : "pointer-events-none border-gray-200 text-gray-300"}`}
          >
            Última
          </a>
        </div>
      </div>
    </div>
  );
}