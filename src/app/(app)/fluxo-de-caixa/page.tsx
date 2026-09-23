import { logError } from "@/core/observability/logger";
import { listCategories } from "@/features/categories/repository";
import {
  DEFAULT_ENTRIES_PAGE_SIZE,
  ENTRIES_PAGE_SIZES,
  computeCashFlowEntries,
} from "@/features/cash-flow/entries-service";
import type { CashFlowEntriesSummary } from "@/features/cash-flow/entries-types";
import { TRANSACTION_TYPES, type TransactionType } from "@/features/transactions/types";
import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/date-utils";
import CashFlowByCategory from "./CashFlowByCategory";
import CashFlowEntriesTable from "./CashFlowEntriesTable";
import { buildEntriesQuery, formatBRL, formatDate, TYPE_LABELS } from "./format";

export const dynamic = "force-dynamic";

/**
 * Fluxo de Caixa: so lancamentos cadastrados em /lancamentos (manual e import).
 * Vendas de marketplace ficam em /marketplaces.
 *
 * INVARIANTE: esta pagina NAO aceita as querystrings `marketplace` nem
 * `paymentMethod`. O next.config.ts redireciona para /marketplaces toda URL que
 * as carrega (links salvos da tela antiga); um filtro com esses nomes aqui
 * ficaria inalcancavel.
 */

const PERIOD_OPTIONS: Array<{ label: string; value: PeriodPreset }> = [
  { label: "Ontem", value: "yesterday" },
  { label: "Hoje", value: "today" },
  { label: "7 dias", value: "d7" },
  { label: "30 dias", value: "d30" },
  { label: "60 dias", value: "d60" },
  { label: "90 dias", value: "d90" },
];

function isPeriodPreset(value: string | undefined): value is PeriodPreset {
  return !!value && PERIOD_PRESETS.includes(value as PeriodPreset);
}

function isTransactionType(value: string | undefined): value is TransactionType {
  return !!value && TRANSACTION_TYPES.includes(value as TransactionType);
}

function normalizeDateInput(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

export default async function FluxoDeCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    startDate?: string;
    endDate?: string;
    categoryId?: string;
    type?: string;
    page?: string;
    limit?: string;
  }>;
}) {
  const params = await searchParams;
  const preset: PeriodPreset = isPeriodPreset(params.preset) ? params.preset : "yesterday";
  const startDate = normalizeDateInput(params.startDate);
  const endDate = normalizeDateInput(params.endDate);
  const categoryId = params.categoryId?.trim() || undefined;
  const type = isTransactionType(params.type) ? params.type : undefined;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const requestedLimit = Number(params.limit ?? DEFAULT_ENTRIES_PAGE_SIZE);
  const limit = (ENTRIES_PAGE_SIZES as readonly number[]).includes(requestedLimit)
    ? requestedLimit
    : DEFAULT_ENTRIES_PAGE_SIZE;

  const baseParams = { preset, startDate, endDate, categoryId, type, limit: String(limit) };

  let summary: CashFlowEntriesSummary;
  let categories: Awaited<ReturnType<typeof listCategories>>;
  try {
    [summary, categories] = await Promise.all([
      computeCashFlowEntries({ preset, startDate, endDate, categoryId, type, page, limit }),
      listCategories(),
    ]);
  } catch (error) {
    // Ramo separado do vazio: falha de banco nunca pode se ler como "nao houve
    // movimento no periodo".
    logError("cash_flow_entries_failed", {
      preset,
      startDate,
      endDate,
      categoryId,
      type,
      page,
      error: error instanceof Error ? error.message : String(error),
    });
    return (
      <div>
        <PageHeader />
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Não foi possível carregar os lançamentos no momento. Nenhum número foi exibido para não
          parecer um período sem movimento; tente novamente em instantes.
        </div>
      </div>
    );
  }

  const { period, totals, previousTotals, byCategory } = summary;
  const isEmpty = totals.incomeCount + totals.expenseCount + totals.transferCount === 0;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          subtitle={`${formatDate(period.startDate)} — ${formatDate(period.endDate)} (${period.days} dias)`}
        />
        <div className="flex flex-wrap gap-2 text-sm">
          {PERIOD_OPTIONS.map((option) => (
            <a
              key={option.value}
              href={`/fluxo-de-caixa${buildEntriesQuery({
                ...baseParams,
                preset: option.value,
                startDate: undefined,
                endDate: undefined,
              })}`}
              className={`rounded-md px-3 py-1.5 ${
                preset === option.value && !startDate && !endDate
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {option.label}
            </a>
          ))}
        </div>
      </div>

      <form
        method="GET"
        className="mb-6 grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-6"
      >
        <input type="hidden" name="preset" value={preset} />
        <div>
          <label htmlFor="startDate" className="mb-1 block text-xs text-gray-600">Data inicial</label>
          <input
            id="startDate"
            type="date"
            name="startDate"
            defaultValue={startDate}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="endDate" className="mb-1 block text-xs text-gray-600">Data final</label>
          <input
            id="endDate"
            type="date"
            name="endDate"
            defaultValue={endDate}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          />
        </div>
        <div>
          <label htmlFor="type" className="mb-1 block text-xs text-gray-600">Tipo</label>
          <select
            id="type"
            name="type"
            defaultValue={type ?? ""}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          >
            <option value="">Todos</option>
            {TRANSACTION_TYPES.map((value) => (
              <option key={value} value={value}>
                {TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="categoryId" className="mb-1 block text-xs text-gray-600">Categoria</label>
          <select
            id="categoryId"
            name="categoryId"
            defaultValue={categoryId ?? ""}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          >
            <option value="">Todas</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name} ({category.direction === "entrada" ? "entrada" : "saída"})
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="limit" className="mb-1 block text-xs text-gray-600">Linhas por página</label>
          <select
            id="limit"
            name="limit"
            defaultValue={String(limit)}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          >
            {ENTRIES_PAGE_SIZES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            className="rounded-md bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-700"
          >
            Filtrar
          </button>
          <a
            href="/fluxo-de-caixa"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Limpar
          </a>
        </div>
      </form>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="Entradas"
          cents={totals.incomeCents}
          count={totals.incomeCount}
          previousCents={previousTotals?.incomeCents ?? null}
        />
        <KpiCard
          label="Saídas"
          cents={totals.expenseCents}
          count={totals.expenseCount}
          previousCents={previousTotals?.expenseCents ?? null}
          inverseColors
        />
        <KpiCard
          label="Saldo líquido"
          cents={totals.balanceCents}
          previousCents={previousTotals?.balanceCents ?? null}
          highlight
        />
      </div>

      {totals.transferCount > 0 && (
        <p className="-mt-4 mb-8 text-xs text-gray-500">
          {totals.transferCount}{" "}
          {totals.transferCount === 1 ? "transferência no período, fora" : "transferências no período, fora"}{" "}
          de Entradas, Saídas e Saldo: movem dinheiro entre contas, não criam nem consomem caixa.
        </p>
      )}

      {isEmpty ? (
        <div className="rounded-md border border-dashed border-gray-300 px-4 py-12 text-center text-sm text-gray-500">
          Nenhum lançamento aprovado neste período.{" "}
          <a href="/lancamentos" className="font-medium text-gray-900 underline">
            Cadastrar ou aprovar em Lançamentos
          </a>
          . Vendas de marketplace ficam em{" "}
          <a href="/marketplaces" className="font-medium text-gray-900 underline">
            Marketplaces
          </a>
          .
        </div>
      ) : (
        <>
          <CashFlowByCategory income={byCategory.income} expense={byCategory.expense} />
          <CashFlowEntriesTable
            items={summary.items}
            pagination={summary.pagination}
            categories={categories}
            query={baseParams}
          />
        </>
      )}
    </div>
  );
}

function PageHeader({ subtitle }: { subtitle?: string }) {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold text-gray-900">Fluxo de Caixa</h1>
      <p className="mt-1 text-sm text-gray-500">
        {subtitle ? `${subtitle} · ` : ""}
        Lançamentos aprovados cadastrados ou importados em Lançamentos. Pendentes não entram.
      </p>
    </div>
  );
}

function KpiCard({
  label,
  cents,
  count,
  previousCents,
  inverseColors = false,
  highlight = false,
}: {
  label: string;
  cents: number;
  count?: number;
  /** null = periodo anterior sem nenhum lancamento: "sem base", nunca "+0,0%". */
  previousCents: number | null;
  inverseColors?: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-5 ${
        highlight ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white"
      }`}
    >
      <p className={`text-xs font-medium uppercase tracking-wide ${highlight ? "text-gray-400" : "text-gray-500"}`}>
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          highlight ? (cents < 0 ? "text-red-300" : "text-white") : "text-gray-900"
        }`}
      >
        {formatBRL(cents)}
      </p>
      <p className={`mt-1 text-xs ${highlight ? "text-gray-400" : "text-gray-500"}`}>
        {count !== undefined && `${count} ${count === 1 ? "lançamento" : "lançamentos"} · `}
        <Delta cents={cents} previousCents={previousCents} inverseColors={inverseColors} highlight={highlight} />
      </p>
    </div>
  );
}

function Delta({
  cents,
  previousCents,
  inverseColors,
  highlight,
}: {
  cents: number;
  previousCents: number | null;
  inverseColors: boolean;
  highlight: boolean;
}) {
  if (previousCents === null) return <span>sem base de comparação</span>;
  if (previousCents === 0) {
    return <span>anterior {formatBRL(0)}</span>;
  }
  const pct = ((cents - previousCents) / Math.abs(previousCents)) * 100;
  const up = cents >= previousCents;
  const good = inverseColors ? !up : up;
  const color = highlight ? "" : good ? "text-green-600" : "text-red-600";
  return (
    <span className={color}>
      {`${pct >= 0 ? "+" : ""}${pct.toFixed(1).replace(".", ",")}%`} vs período anterior
    </span>
  );
}
