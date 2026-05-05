import { computeCashFlow } from "@/features/cash-flow/service";

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
  integration: "Integração",
  webhook: "Webhook",
};

export default async function FluxoDeCaixaPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const params = await searchParams;
  const days = Number(params.days ?? "30");

  let summary;
  try {
    summary = await computeCashFlow({ days });
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

  const { period, totalIncomeCents, totalExpenseCents, netCents, bySource, previousPeriod } =
    summary;

  return (
    <div>
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Fluxo de Caixa</h1>
          <p className="mt-1 text-sm text-gray-500">
            {formatDate(period.startDate)} — {formatDate(period.endDate)} ({period.days} dias)
          </p>
        </div>
        <div className="flex gap-2 text-sm">
          {[30, 60, 90].map((d) => (
            <a
              key={d}
              href={`/financeiro/fluxo-de-caixa?days=${d}`}
              className={`rounded-md px-3 py-1.5 ${
                days === d
                  ? "bg-gray-900 text-white"
                  : "border border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {d}d
            </a>
          ))}
        </div>
      </div>

      {/* Cards de totais */}
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
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
          label="Líquido"
          cents={netCents}
          previousCents={previousPeriod?.netCents ?? null}
          highlight
        />
      </div>

      {/* Breakdown por origem */}
      <div>
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
                      {SOURCE_LABELS[row.source] ?? row.source}
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
