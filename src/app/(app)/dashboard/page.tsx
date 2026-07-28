import { computeCashFlow } from "@/features/cash-flow/service";
import PaymentMethodRevenueCards from "../_components/PaymentMethodRevenueCards";
import MarketplaceRevenueCards from "../_components/MarketplaceRevenueCards";
import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/date-utils";

export const dynamic = "force-dynamic";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(iso));
}

function deltaPercent(current: number, previous: number): string {
  if (previous === 0) return "—";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function deltaClass(current: number, previous: number, inverseColors = false) {
  const up = current >= previous;
  const positive = inverseColors ? !up : up;
  return positive ? "text-green-600" : "text-red-500";
}

type PresetOption = { label: string; value: PeriodPreset };

const PRESET_OPTIONS: PresetOption[] = [
  { label: "Ontem", value: "yesterday" },
  { label: "Hoje", value: "today" },
  { label: "7 dias", value: "d7" },
  { label: "30 dias", value: "d30" },
  { label: "60 dias", value: "d60" },
  { label: "90 dias", value: "d90" },
];

const PRESET_TO_DAYS: Record<PeriodPreset, number> = {
  yesterday: 1,
  today: 1,
  d7: 7,
  d30: 30,
  d60: 60,
  d90: 90,
};

function isPreset(value: string | undefined): value is PeriodPreset {
  if (!value) return false;
  return PERIOD_PRESETS.includes(value as PeriodPreset);
}

type Props = {
  searchParams: Promise<{ days?: string; preset?: string }>;
};

export default async function DashboardPage({ searchParams }: Props) {
  const params = await searchParams;
  const preset: PeriodPreset = isPreset(params.preset) ? params.preset : "yesterday";
  const days = parseInt(params.days ?? String(PRESET_TO_DAYS[preset]), 10) || PRESET_TO_DAYS[preset];

  let summary;
  try {
    summary = await computeCashFlow({ preset, days });
  } catch {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-gray-900">Dashboard Financeiro</h1>
          <p className="mt-1 text-sm text-gray-500">Nao foi possivel carregar os dados no momento.</p>
        </div>
        <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Falha ao conectar ao banco de dados. Verifique DATABASE_URL, CORE_DB_URL e OMS_DB_URL no ambiente atual.
        </div>
      </div>
    );
  }

  const {
    period,
    totalIncomeCents,
    totalExpenseCents,
    totalShippingCents,
    bySource,
    byPaymentMethod,
    previousPeriod,
  } = summary;

  return (
    <div className="w-full space-y-8">
      {/* Cabeçalho + seletor de período */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Dashboard Financeiro</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            {formatDate(period.startDate)} — {formatDate(period.endDate)}
          </p>
        </div>
        <div className="flex gap-1">
          {PRESET_OPTIONS.map((opt) => (
            <a
              key={opt.value}
              href={`/dashboard?preset=${opt.value}`}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                preset === opt.value
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-200 text-gray-500 hover:bg-gray-50"
              }`}
            >
              {opt.label}
            </a>
          ))}
        </div>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <SummaryCard
          label="Receita bruta"
          value={formatBRL(totalIncomeCents)}
          delta={previousPeriod ? deltaPercent(totalIncomeCents, previousPeriod.totalIncomeCents) : null}
          deltaClass={previousPeriod ? deltaClass(totalIncomeCents, previousPeriod.totalIncomeCents) : "text-gray-400"}
        />
        <SummaryCard
          label="Despesas"
          value={formatBRL(totalExpenseCents)}
          delta={previousPeriod ? deltaPercent(totalExpenseCents, previousPeriod.totalExpenseCents) : null}
          deltaClass={previousPeriod ? deltaClass(totalExpenseCents, previousPeriod.totalExpenseCents, true) : "text-gray-400"}
        />
        <SummaryCard
          label="Entrega"
          value={formatBRL(totalShippingCents)}
          delta={previousPeriod ? deltaPercent(totalShippingCents, previousPeriod.totalShippingCents) : null}
          deltaClass={previousPeriod ? deltaClass(totalShippingCents, previousPeriod.totalShippingCents, true) : "text-gray-400"}
        />
      </div>

      <PaymentMethodRevenueCards
        title="Faturamento por forma de pagamento"
        current={byPaymentMethod ?? []}
        previous={previousPeriod?.byPaymentMethod ?? null}
      />

      <MarketplaceRevenueCards title="Faturamento por marketplace" current={bySource ?? []} />

      {/* Comparativo de período */}
      {previousPeriod && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-gray-700">Comparativo — período anterior</h2>
          <div className="grid grid-cols-3 gap-4">
            <CompareCard
              label="Receita"
              current={totalIncomeCents}
              previous={previousPeriod.totalIncomeCents}
              format={formatBRL}
            />
            <CompareCard
              label="Despesas"
              current={totalExpenseCents}
              previous={previousPeriod.totalExpenseCents}
              format={formatBRL}
              inverseColors
            />
          </div>
        </section>
      )}

      {bySource.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-200 p-10 text-center text-sm text-gray-400">
          Nenhuma transação encontrada no período selecionado.
        </div>
      )}
    </div>
  );
}

// ─── Componentes auxiliares ───────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  valueClass = "text-gray-900",
  delta,
  deltaClass: dc = "text-gray-400",
  sublabel,
}: {
  label: string;
  value: string;
  valueClass?: string;
  delta?: string | null;
  deltaClass?: string;
  sublabel?: string;
}) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${valueClass}`}>{value}</p>
      {delta && <p className={`mt-0.5 text-xs font-medium ${dc}`}>{delta} vs período anterior</p>}
      {sublabel && <p className="mt-0.5 text-xs text-gray-400">{sublabel}</p>}
    </div>
  );
}

function CompareCard({
  label,
  current,
  previous,
  format,
  inverseColors = false,
}: {
  label: string;
  current: number;
  previous: number;
  format: (v: number) => string;
  inverseColors?: boolean;
}) {
  const pct = previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;
  const up = current >= previous;
  const positive = inverseColors ? !up : up;
  const colorClass = pct === null ? "text-gray-400" : positive ? "text-green-600" : "text-red-500";

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <p className="mb-2 text-xs text-gray-500">{label}</p>
      <div className="flex items-end justify-between gap-2">
        <div>
          <p className="text-xs text-gray-400">Anterior</p>
          <p className="font-mono text-sm text-gray-500">{format(previous)}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-gray-400">Atual</p>
          <p className="font-mono text-sm font-medium text-gray-900">{format(current)}</p>
        </div>
      </div>
      {pct !== null && (
        <p className={`mt-2 text-center text-xs font-medium ${colorClass}`}>
          {pct >= 0 ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%
        </p>
      )}
    </div>
  );
}
