import { computeCashFlow } from "@/features/cash-flow/service";
import { listMarketplaceReadModelPaginated } from "@/features/transactions/read-model";
import ExportControls from "./ExportControls";
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

function formatOriginLabel(value: string): string {
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

const PERIOD_OPTIONS: Array<{ label: string; value: PeriodPreset }> = [
  { label: "Ontem", value: "yesterday" },
  { label: "Hoje", value: "today" },
  { label: "7 dias", value: "d7" },
  { label: "30 dias", value: "d30" },
  { label: "60 dias", value: "d60" },
  { label: "90 dias", value: "d90" },
];

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  credit_card: "Cartão de crédito",
  pix: "Pix",
  store_credit: "Crédito em loja",
  boleto: "Boleto",
  bank_transfer: "Transferência",
  wallet: "Carteira digital",
  cash: "Dinheiro",
  other: "Outro",
};

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

function parseOrderNumber(item: FinancialTransaction): string {
  if (item.orderNumber) {
    // Garante prefixo # e exibe todos os dígitos
    const clean = item.orderNumber.replace(/^#/, "");
    return `#${clean}`;
  }
  if (!item.description) return "—";
  const match = item.description.match(/Pedido\s*#\s*([\w-]+)/i);
  return match ? `#${match[1].replace(/^#/, "")}` : "—";
}

function formatPaymentMethod(item: FinancialTransaction): string {
  if (item.paymentMethodRaw) return item.paymentMethodRaw;
  if (item.paymentMethodNormalized) {
    return PAYMENT_METHOD_LABELS[item.paymentMethodNormalized];
  }
  return "Não informado";
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
  } catch {
    // Mantém o resumo visível mesmo se a listagem detalhada falhar no cutover.
  }

  const {
    period,
    totalIncomeCents,
    totalExpenseCents,
    totalDiscountCents,
    totalFeesCents,
    totalShippingCents,
    netCents,
    bySource,
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

  const marketplacePageTotals = marketplaceEntries.reduce(
    (acc, item) => {
      acc.shippingCents += item.shippingCents ?? 0;
      acc.discountCents += item.discountCents ?? 0;
      acc.feesAndTaxesCents += (item.taxCents ?? 0) + (item.feeCents ?? 0);
      acc.amountCents += item.amountCents;
      return acc;
    },
    {
      shippingCents: 0,
      discountCents: 0,
      feesAndTaxesCents: 0,
      amountCents: 0,
    }
  );

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
              href={`/financeiro/fluxo-de-caixa${buildFlowQuery({
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
            href="/financeiro/fluxo-de-caixa"
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
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
          label="Taxas"
          cents={totalFeesCents}
          previousCents={previousPeriod?.totalTaxCents ?? null}
          inverseColors
        />
        <SummaryCard
          label="Descontos"
          cents={totalDiscountCents}
          previousCents={previousPeriod?.totalDiscountCents ?? null}
          inverseColors
        />
        <SummaryCard
          label="Entrega"
          cents={totalShippingCents}
          previousCents={previousPeriod?.totalShippingCents ?? null}
          inverseColors
        />
        <SummaryCard
          label="Líquido"
          cents={netCents}
          previousCents={previousPeriod?.netCents ?? null}
          highlight
        />
      </div>

      <div className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Entradas de marketplaces
        </h2>

        {marketplaceEntries.length === 0 ? (
          <div className="rounded-md border border-dashed border-gray-300 py-10 text-center text-sm text-gray-500">
            Nenhuma entrada de marketplace encontrada com os filtros atuais.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Marketplace</th>
                  <th className="px-4 py-3 text-left">Número do pedido</th>
                  <th className="px-4 py-3 text-left">Data</th>
                  <th className="px-4 py-3 text-left">Forma de pagamento</th>
                  <th className="px-4 py-3 text-right">Entrega</th>
                  <th className="px-4 py-3 text-right">Descontos</th>
                  <th className="px-4 py-3 text-right">Taxas</th>
                  <th className="px-4 py-3 text-right">Valor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {marketplaceEntries.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50">
                    <td className="whitespace-nowrap px-4 py-3 text-gray-700 capitalize">
                      {item.marketplace ?? item.externalSource ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900">
                      {parseOrderNumber(item)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                      {formatDate(item.occurredAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                      {formatPaymentMethod(item)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600">
                      {formatBRL(item.shippingCents ?? 0)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600">
                      {formatBRL(item.discountCents ?? 0)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right text-gray-600">
                      {formatBRL((item.taxCents ?? 0) + (item.feeCents ?? 0))}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-green-700">
                      {formatBRL(item.amountCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-gray-50">
                <tr>
                  <td className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-gray-600" colSpan={4}>
                    Total da página
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-700">
                    {formatBRL(marketplacePageTotals.shippingCents)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-700">
                    {formatBRL(marketplacePageTotals.discountCents)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-gray-700">
                    {formatBRL(marketplacePageTotals.feesAndTaxesCents)}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-right text-sm font-semibold text-green-700">
                    {formatBRL(marketplacePageTotals.amountCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
          <span>
            Exibindo {marketplaceEntries.length} registros na página {pagination.page}
          </span>
          <div className="flex gap-2">
            <a
              href={`/financeiro/fluxo-de-caixa${buildFlowQuery({
                ...baseParams,
                page: pagination.page > 1 ? String(pagination.page - 1) : "1",
              })}`}
              className={`rounded border px-2 py-1 ${pagination.page > 1 ? "border-gray-300 text-gray-700 hover:bg-gray-50" : "border-gray-200 text-gray-300 pointer-events-none"}`}
            >
              Anterior
            </a>
            <a
              href={`/financeiro/fluxo-de-caixa${buildFlowQuery({
                ...baseParams,
                page: pagination.hasNext ? String(pagination.page + 1) : String(pagination.page),
              })}`}
              className={`rounded border px-2 py-1 ${pagination.hasNext ? "border-gray-300 text-gray-700 hover:bg-gray-50" : "border-gray-200 text-gray-300 pointer-events-none"}`}
            >
              Próxima
            </a>
          </div>
        </div>
      </div>

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
                      {formatBRL(row.feesCents)}
                    </td>
                    <td
                      className={`whitespace-nowrap px-4 py-3 text-right font-medium ${
                        row.netCents >= 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {formatBRL(row.netCents)}
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
