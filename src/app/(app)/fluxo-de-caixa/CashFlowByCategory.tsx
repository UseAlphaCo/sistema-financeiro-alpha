import type { CashFlowEntriesByCategory } from "@/features/cash-flow/entries-types";
import { formatBRL } from "./format";

export default function CashFlowByCategory({
  income,
  expense,
}: {
  income: CashFlowEntriesByCategory[];
  expense: CashFlowEntriesByCategory[];
}) {
  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Por categoria</h2>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CategoryList title="Entradas" rows={income} emptyLabel="Nenhuma entrada no período." />
        <CategoryList title="Saídas" rows={expense} emptyLabel="Nenhuma saída no período." />
      </div>
    </div>
  );
}

function CategoryList({
  title,
  rows,
  emptyLabel,
}: {
  title: string;
  rows: CashFlowEntriesByCategory[];
  emptyLabel: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs font-medium uppercase tracking-wide text-gray-500">
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-gray-500">{emptyLabel}</p>
      ) : (
        <table className="min-w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Categoria</th>
              <th>Valor</th>
              <th>Lançamentos</th>
              <th>Participação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row) => (
              <tr key={row.categoryId ?? "__none__"}>
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2 text-gray-900">
                    <span
                      aria-hidden
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-gray-300"
                      style={row.color ? { backgroundColor: row.color, borderColor: row.color } : undefined}
                    />
                    <span className={row.categoryId === null ? "italic text-gray-500" : ""}>{row.name}</span>
                  </span>
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums text-gray-900">
                  {formatBRL(row.totalCents)}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-gray-500">
                  {row.count}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-gray-500">
                  {(row.share * 100).toFixed(1).replace(".", ",")}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
