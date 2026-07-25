import type { CashFlowByPaymentMethod } from "@/features/cash-flow/types";
import { PAYMENT_METHOD_LABELS } from "@/features/transactions/format";
import { PAYMENT_METHODS } from "@/features/transactions/types";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function deltaPercent(current: number, previous: number): string {
  if (previous === 0) return "—";
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function deltaClass(current: number, previous: number): string {
  return current >= previous ? "text-green-600" : "text-red-500";
}

function formatCount(value: number): string {
  return value === 1 ? "1 transação" : `${value} transações`;
}

type Props = {
  title: string;
  current: CashFlowByPaymentMethod[];
  previous?: CashFlowByPaymentMethod[] | null;
};

export default function PaymentMethodRevenueCards({ title, current, previous }: Props) {
  const currentMap = new Map(current.map((item) => [item.paymentMethod, item]));
  const previousMap = new Map((previous ?? []).map((item) => [item.paymentMethod, item]));
  const visibleMethods = PAYMENT_METHODS.filter(
    (method) => (currentMap.get(method)?.grossCents ?? 0) > 0 || (previousMap.get(method)?.grossCents ?? 0) > 0
  );

  if (visibleMethods.length === 0) {
    return (
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-6 text-sm text-gray-500">
          Nenhum faturamento por forma de pagamento encontrado.
        </div>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
        {visibleMethods.map((method) => {
          const currentItem = currentMap.get(method) ?? { grossCents: 0, transactionCount: 0 };
          const previousItem = previousMap.get(method);

          return (
            <div key={method} className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                {PAYMENT_METHOD_LABELS[method]}
              </p>
              <p className="mt-2 text-xl font-semibold tabular-nums text-gray-900">
                {formatBRL(currentItem.grossCents)}
              </p>
              <p className="mt-1 text-xs text-gray-400">{formatCount(currentItem.transactionCount)}</p>
              {previousItem ? (
                <p className={`mt-1 text-xs font-medium ${deltaClass(currentItem.grossCents, previousItem.grossCents)}`}>
                  {deltaPercent(currentItem.grossCents, previousItem.grossCents)} vs período anterior
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}