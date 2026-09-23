import { formatOriginLabel } from "@/features/cash-flow/source-labels";
import type { FinancialTransaction } from "@/features/transactions/types";
import { buildEntriesQuery, formatBRL, formatDate, TYPE_LABELS } from "./format";

type Pagination = { page: number; limit: number; total: number; hasNext: boolean };

/**
 * Server Component: sem seletor de colunas, logo sem localStorage e sem bundle
 * de cliente. Somente leitura -- editar e excluir continuam em /lancamentos.
 */
export default function CashFlowEntriesTable({
  items,
  pagination,
  categories,
  query,
}: {
  items: FinancialTransaction[];
  pagination: Pagination;
  categories: Array<{ id: string; name: string }>;
  query: Record<string, string | undefined>;
}) {
  const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
  const pageCount = Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.limit)));
  const pageLink = (page: number) => `/fluxo-de-caixa${buildEntriesQuery({ ...query, page })}`;

  // Saldo da pagina com o mesmo sinal dos cards: transferencia nao soma.
  const pageBalance = items.reduce((sum, item) => {
    if (item.type === "income") return sum + item.amountCents;
    if (item.type === "expense") return sum - item.amountCents;
    return sum;
  }, 0);

  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Lançamentos</h2>
        <a href="/lancamentos" className="text-xs text-gray-500 underline hover:text-gray-900">
          Editar em Lançamentos
        </a>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500">
          Nenhum lançamento nesta página.{" "}
          <a href={pageLink(1)} className="font-medium text-gray-900 underline">
            Voltar para a primeira
          </a>
          .
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">Data</th>
                <th className="px-4 py-3 text-left">Tipo</th>
                <th className="px-4 py-3 text-left">Categoria</th>
                <th className="px-4 py-3 text-left">Descrição</th>
                <th className="px-4 py-3 text-left">Origem</th>
                <th className="px-4 py-3 text-right">Valor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map((item) => (
                <tr key={item.id} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-gray-700">{formatDate(item.occurredAt)}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-700">{TYPE_LABELS[item.type]}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-700">
                    {item.categoryId ? categoryNames.get(item.categoryId) ?? "Categoria removida" : (
                      <span className="italic text-gray-400">Sem categoria</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{item.description ?? "—"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-500">{formatOriginLabel(item.source)}</td>
                  <td
                    className={`whitespace-nowrap px-4 py-3 text-right font-medium tabular-nums ${
                      item.type === "expense" ? "text-red-700" : item.type === "income" ? "text-gray-900" : "text-gray-500"
                    }`}
                  >
                    {item.type === "expense" ? "− " : ""}
                    {formatBRL(item.amountCents)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-gray-50 text-sm">
              <tr>
                <td colSpan={5} className="px-4 py-3 text-right text-xs uppercase tracking-wide text-gray-500">
                  Saldo desta página
                </td>
                <td
                  className={`whitespace-nowrap px-4 py-3 text-right font-semibold tabular-nums ${
                    pageBalance < 0 ? "text-red-700" : "text-gray-900"
                  }`}
                >
                  {formatBRL(pageBalance)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-sm text-gray-600">
        <span>
          Página {pagination.page} de {pageCount} · {pagination.total}{" "}
          {pagination.total === 1 ? "lançamento" : "lançamentos"}
        </span>
        <div className="flex gap-2">
          {pagination.page > 1 && (
            <a href={pageLink(pagination.page - 1)} className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
              Anterior
            </a>
          )}
          {pagination.hasNext && (
            <a href={pageLink(pagination.page + 1)} className="rounded-md border border-gray-300 px-3 py-1.5 hover:bg-gray-50">
              Próxima
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
