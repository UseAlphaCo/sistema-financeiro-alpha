import { logError } from "@/core/observability/logger";
import { computeCashFlow } from "@/features/cash-flow/service";
import { formatOriginLabel } from "@/features/cash-flow/source-labels";
import { listMarketplaceReadModelPaginated } from "@/features/transactions/read-model";
import ExportControls from "./ExportControls";
import PaymentMethodRevenueCards from "../_components/PaymentMethodRevenueCards";
import FluxoDeCaixaTable from "./FluxoDeCaixaTable";
import { PAYMENT_METHOD_LABELS } from "@/features/transactions/format";
import {
  PAYMENT_METHODS,
  type FinancialTransaction,
  type PaymentMethod,
} from "@/features/transactions/types";
import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/date-utils";

export const dynamic = "force-dynamic";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(
    new Date(iso)
  );
}

function deltaPercent(current: number, previous: number): string {
  if (previous === 0) return "—";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function deltaClass(current: number, previous: number, inverseColors = false) {
  const up = current >= previous;
  const positive = inverseColors ? !up : up;
  return positive ? "text-green-600" : "text-red-600";
}

const PERIOD_OPTIONS: Array<{ label: string; value: PeriodPreset }> = [
  { label: "Ontem", value: "yesterday" },
  { label: "Hoje", value: "today" },
  { label: "7 dias", value: "d7" },
  { label: "30 dias", value: "d30" },
  { label: "60 dias", value: "d60" },
  { label: "90 dias", value: "d90" },
];

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

const MARKETPLACE_OPTIONS = [
  { value: "shopify", label: "Shopify" },
  { value: "anymarket", label: "Anymarket" },
  { value: "mercado_livre", label: "Mercado Livre" },
  { value: "shopee", label: "Shopee" },
  { value: "amazon", label: "Amazon" },
  { value: "todos", label: "Todos" },
] as const;

function isPaymentMethod(value: string | undefined): value is PaymentMethod {
  if (!value) return false;
  return PAYMENT_METHODS.includes(value as PaymentMethod);
}

function isPeriodPreset(value: string | undefined): value is PeriodPreset {
  if (!value) return false;
  return PERIOD_PRESETS.includes(value as PeriodPreset);
}

function normalizeMarketplaceInput(value: string | undefined): string {
  if (!value) return "shopify";

  const normalized = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");

  if (normalized === "mercadolivre") return "mercado_livre";

  if (MARKETPLACE_OPTIONS.some((option) => option.value === normalized)) {
    return normalized;
  }

  return "shopify";
}

function normalizeDateInput(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  return undefined;
}

function buildFlowQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (!value) continue;
    search.set(key, value);
  }

  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export default async function FluxoDeCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    startDate?: string;
    endDate?: string;
    marketplace?: string;
    paymentMethod?: string;
    page?: string;
    limit?: string;
  }>;
}) {
  const params = await searchParams;
  const preset: PeriodPreset = isPeriodPreset(params.preset) ? params.preset : "yesterday";
  const startDate = normalizeDateInput(params.startDate);
  const endDate = normalizeDateInput(params.endDate);
  const marketplace = normalizeMarketplaceInput(params.marketplace);
  const paymentMethod = isPaymentMethod(params.paymentMethod)
    ? params.paymentMethod
    : undefined;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const requestedLimit = Number(params.limit ?? "50") || 50;
  const limit = PAGE_SIZE_OPTIONS.includes(requestedLimit as (typeof PAGE_SIZE_OPTIONS)[number])
    ? requestedLimit
    : 50;

  const cashFlowFilters = {
    preset,
    marketplace: marketplace === "todos" ? undefined : marketplace,
    paymentMethod,
    startDate,
    endDate,
  };

  let summary;
  let marketplaceEntries: FinancialTransaction[] = [];
  let listFailed = false;
  let pagination = {
    page: 1,
    limit,
    total: 0,
    hasNext: false,
  };

  let summaryResult;
  try {
    summaryResult = await computeCashFlow(cashFlowFilters);
    summary = summaryResult;
  } catch {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Fluxo de Caixa</h1>
          <p className="mt-1 text-sm text-gray-500">Nao foi possivel carregar os dados no momento.</p>
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Falha ao conectar ao banco de dados. Verifique DATABASE_URL e DIRECT_URL no ambiente atual.
        </div>
      </div>
    );
  }

  try {
    const paginated = await listMarketplaceReadModelPaginated({
      page,
      limit,
      marketplace: marketplace === "todos" ? undefined : marketplace,
      paymentMethod,
      startDate: summaryResult.period.startDate,
      endDate: summaryResult.period.endDate,
    });

    marketplaceEntries = paginated.items;
    pagination = paginated.pagination;
  } catch (error) {
    // Mantém o resumo visível mesmo se a listagem detalhada falhar, mas
    // sinaliza o erro (log + UI) em vez de aparentar "sem resultados".
    listFailed = true;
    logError("fluxo_caixa_marketplace_entries_failed", {
      marketplace,
      paymentMethod,
      startDate: summaryResult.period.startDate,
      endDate: summaryResult.period.endDate,
      page,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const {
    period,
    totalIncomeCents,
    totalExpenseCents,
    totalShippingCents,
    bySource,
    byPaymentMethod,
    previousPeriod,
  } =
    summary;

  const baseParams = {
    preset,
    marketplace,
    paymentMethod,
    startDate,
    endDate,
    limit: String(limit),
  };

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Fluxo de Caixa</h1>
          <p className="mt-1 text-sm text-gray-500">
            {formatDate(period.startDate)} — {formatDate(period.endDate)} ({period.days} dias)
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {PERIOD_OPTIONS.map((option) => (
            <a
              key={option.value}
              href={`/fluxo-de-caixa${buildFlowQuery({
                preset: option.value,
                marketplace,
                paymentMethod,
                limit: String(limit),
              })}`}
              className={`rounded-md px-3 py-1.5 ${
                preset === option.value
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {option.label}
            </a>
          ))}
        </div>
      </div>

      <form method="GET" className="mb-6 grid grid-cols-1 gap-3 rounded-lg border border-gray-200 bg-white p-4 sm:grid-cols-6">
        <input type="hidden" name="preset" value={preset} />
        <div>
          <label className="mb-1 block text-xs text-gray-600">Data inicial</label>
          <input
            type="date"
            name="startDate"
            defaultValue={startDate}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-600">Data final</label>
          <input
            type="date"
            name="endDate"
            defaultValue={endDate}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-600">Marketplace</label>
          <select
            name="marketplace"
            defaultValue={marketplace}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          >
            {MARKETPLACE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-600">Forma de pagamento</label>
          <select
            name="paymentMethod"
            defaultValue={paymentMethod ?? ""}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          >
            <option value="">Todas</option>
            {PAYMENT_METHODS.map((method) => (
              <option key={method} value={method}>
                {PAYMENT_METHOD_LABELS[method]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-600">Linhas por página</label>
          <select
            name="limit"
            defaultValue={String(limit)}
            className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
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

      <ExportControls
        filters={{
          preset,
          startDate,
          endDate,
          marketplace,
          paymentMethod,
        }}
      />

      {/* Cards de totais */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <SummaryCard
          label="Receita bruta"
          cents={totalIncomeCents}
          previousCents={previousPeriod?.totalIncomeCents ?? null}
        />
        <SummaryCard
          label="Despesas"
          cents={totalExpenseCents}
          previousCents={previousPeriod?.totalExpenseCents ?? null}
          inverseColors
        />
        <SummaryCard
          label="Entrega"
          cents={totalShippingCents}
          previousCents={previousPeriod?.totalShippingCents ?? null}
          inverseColors
        />
      </div>

      <PaymentMethodRevenueCards
        title="Faturamento por forma de pagamento"
        current={byPaymentMethod}
        previous={previousPeriod?.byPaymentMethod ?? []}
      />

      {listFailed ? (
        <div className="mt-8 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Não foi possível carregar as entradas de marketplaces no momento. Os totais acima continuam
          válidos; tente novamente em instantes.
        </div>
      ) : (
        <FluxoDeCaixaTable items={marketplaceEntries} pagination={pagination} query={baseParams} />
      )}

      {/* Breakdown por origem */}
      <div className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Por origem
        </h2>

        {bySource.length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-300 py-12 text-center text-sm text-gray-500">
            Nenhuma transação aprovada neste período.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Origem</th>
                  <th className="px-4 py-3 text-right">Receita bruta</th>
                  <th className="px-4 py-3 text-right">Despesas</th>
                  <th className="px-4 py-3 text-right">Líquido</th>
                  <th className="px-4 py-3 text-right">Transações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {bySource.map((row) => (
                  <tr key={row.source} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900">
                      {formatOriginLabel(row.source)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-700">
                      {formatBRL(row.grossCents)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-700">
                      {formatBRL(row.expenseCents)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-gray-900">
                      {formatBRL(row.grossCents - row.expenseCents)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-500">
                      {row.transactionCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  cents,
  previousCents,
  highlight = false,
  inverseColors = false,
}: {
  label: string;
  cents: number;
  previousCents: number | null;
  highlight?: boolean;
  inverseColors?: boolean;
}) {
  const hasPrev = previousCents !== null;

  return (
    <div
      className={`rounded-lg border p-5 ${
        highlight ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 bg-white"
      }`}
    >
      <p
        className={`text-xs font-medium uppercase tracking-wide ${
          highlight ? "text-gray-400" : "text-gray-500"
        }`}
      >
        {label}
      </p>
      <p
        className={`mt-2 text-2xl font-semibold tabular-nums ${
          highlight ? "text-white" : "text-gray-900"
        }`}
      >
        {formatBRL(cents)}
      </p>
      {hasPrev && (
        <p
          className={`mt-1 text-xs ${
            highlight
              ? "text-gray-400"
              : deltaClass(cents, previousCents, inverseColors)
          }`}
        >
          {deltaPercent(cents, previousCents)} vs período anterior
        </p>
      )}
    </div>
  );
}
