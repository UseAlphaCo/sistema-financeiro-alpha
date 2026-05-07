import { computeCashFlow } from "@/features/cash-flow/service";
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

const SOURCE_LABELS: Record<string, string> = {
  shopify: "Shopify",
  mercado_livre: "Mercado Livre",
  shopee: "Shopee",
  amazon: "Amazon",
  manual: "Manual",
  import: "Importação",
  integration: "Integração",
  webhook: "Webhook",
};

const SOURCE_COLORS: Record<string, string> = {
  shopify: "bg-green-500",
  mercado_livre: "bg-yellow-400",
  shopee: "bg-orange-500",
  amazon: "bg-blue-500",
  manual: "bg-gray-400",
  import: "bg-purple-500",
  integration: "bg-teal-500",
  webhook: "bg-indigo-500",
};

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

  const summary = await computeCashFlow({ preset, days });

  const {
    period,
    totalIncomeCents,
    totalExpenseCents,
    totalFeesCents,
    totalDiscountCents,
    totalShippingCents,
    netCents,
    bySource,
    previousPeriod,
  } = summary;

  const totalNetMarketplace = bySource.reduce((acc, s) => acc + s.netCents, 0);

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
              href={`/financeiro/dashboard?preset=${opt.value}`}
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
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
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
          label="Taxas totais"
          value={formatBRL(totalFeesCents)}
          sublabel="descontadas da receita"
          delta={previousPeriod ? deltaPercent(totalFeesCents, previousPeriod.totalTaxCents) : null}
          deltaClass={previousPeriod ? deltaClass(totalFeesCents, previousPeriod.totalTaxCents, true) : "text-gray-400"}
        />
        <SummaryCard
          label="Descontos"
          value={formatBRL(totalDiscountCents)}
          delta={previousPeriod ? deltaPercent(totalDiscountCents, previousPeriod.totalDiscountCents) : null}
          deltaClass={previousPeriod ? deltaClass(totalDiscountCents, previousPeriod.totalDiscountCents, true) : "text-gray-400"}
        />
        <SummaryCard
          label="Entrega"
          value={formatBRL(totalShippingCents)}
          delta={previousPeriod ? deltaPercent(totalShippingCents, previousPeriod.totalShippingCents) : null}
          deltaClass={previousPeriod ? deltaClass(totalShippingCents, previousPeriod.totalShippingCents, true) : "text-gray-400"}
        />
        <SummaryCard
          label="Líquido"
          value={formatBRL(netCents)}
          valueClass={netCents >= 0 ? "text-green-600" : "text-red-500"}
          delta={previousPeriod ? deltaPercent(netCents, previousPeriod.netCents) : null}
          deltaClass={previousPeriod ? deltaClass(netCents, previousPeriod.netCents) : "text-gray-400"}
        />
      </div>

      {/* Breakdown por marketplace */}
      {bySource.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-medium text-gray-700">Resultado líquido por origem</h2>
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
            {/* Barra de proporção */}
            <div className="flex h-2">
              {bySource
                .filter((s) => s.netCents > 0)
                .map((s, i) => {
                  const pct = totalNetMarketplace > 0 ? (s.netCents / totalNetMarketplace) * 100 : 0;
                  return (
                    <div
                      key={i}
                      className={`${SOURCE_COLORS[s.source] ?? "bg-gray-300"} first:rounded-l-lg last:rounded-r-lg`}
                      style={{ width: `${pct}%` }}
                      title={`${SOURCE_LABELS[s.source] ?? s.source}: ${pct.toFixed(1)}%`}
                    />
                  );
                })}
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-gray-500">
                  <th className="px-4 py-2 font-normal">Origem</th>
                  <th className="px-4 py-2 text-right font-normal">Bruto</th>
                  <th className="px-4 py-2 text-right font-normal">Taxas</th>
                  <th className="px-4 py-2 text-right font-normal">Líquido</th>
                  <th className="px-4 py-2 text-right font-normal">Transações</th>
                  <th className="px-4 py-2 text-right font-normal">% do total</th>
                </tr>
              </thead>
              <tbody>
                {bySource.map((s, i) => {
                  const sharePct =
                    totalNetMarketplace > 0
                      ? ((s.netCents / totalNetMarketplace) * 100).toFixed(1)
                      : "—";
                  return (
                    <tr key={i} className="border-b border-gray-50 last:border-0 hover:bg-gray-50">
                      <td className="flex items-center gap-2 px-4 py-3">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${SOURCE_COLORS[s.source] ?? "bg-gray-300"}`}
                        />
                        {SOURCE_LABELS[s.source] ?? s.source}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{formatBRL(s.grossCents)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-red-400">
                        {s.feesCents > 0 ? `- ${formatBRL(s.feesCents)}` : "—"}
                      </td>
                      <td
                        className={`px-4 py-3 text-right font-mono text-xs font-medium ${s.netCents >= 0 ? "text-green-600" : "text-red-500"}`}
                      >
                        {formatBRL(s.netCents)}
                      </td>
                      <td className="px-4 py-3 text-right text-xs text-gray-500">{s.transactionCount}</td>
                      <td className="px-4 py-3 text-right text-xs text-gray-400">{sharePct !== "—" ? `${sharePct}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t bg-gray-50 text-xs font-medium text-gray-700">
                  <td className="px-4 py-2">Total</td>
                  <td className="px-4 py-2 text-right font-mono">{formatBRL(totalIncomeCents)}</td>
                  <td className="px-4 py-2 text-right font-mono text-red-400">
                    {totalFeesCents > 0 ? `- ${formatBRL(totalFeesCents)}` : "—"}
                  </td>
                  <td className={`px-4 py-2 text-right font-mono ${netCents >= 0 ? "text-green-600" : "text-red-500"}`}>
                    {formatBRL(netCents)}
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    {bySource.reduce((acc, s) => acc + s.transactionCount, 0)}
                  </td>
                  <td className="px-4 py-2 text-right">100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

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
            <CompareCard
              label="Líquido"
              current={netCents}
              previous={previousPeriod.netCents}
              format={formatBRL}
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
