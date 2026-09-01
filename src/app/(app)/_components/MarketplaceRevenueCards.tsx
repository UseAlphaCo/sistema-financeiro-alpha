import type { CashFlowBySource } from "@/features/cash-flow/types";
import { formatOriginLabel } from "@/features/cash-flow/source-labels";

function formatBRL(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

/**
 * O substantivo muda com a base da linha, e nao e preciosismo: em "pedidos" um
 * pedido pago com Pix mais credito na loja conta 1, em "pagamentos" conta 2.
 * Chamar os dois de "transacoes" convidava a somar as duas bases.
 */
function formatCount(value: number, basis: CashFlowBySource["basis"]): string {
  if (basis === "payments") {
    return value === 1 ? "1 transação" : `${value} transações`;
  }
  return value === 1 ? "1 pedido" : `${value} pedidos`;
}

type Props = {
  title: string;
  current: CashFlowBySource[];
  /**
   * Periodo posterior ao que ja foi materializado (`not_yet` em
   * read-model-freshness.ts). Muda o estado vazio: "nenhum faturamento
   * encontrado" afirma que o periodo esta vazio, e ele so nao foi processado.
   */
  unavailable?: boolean;
};

export default function MarketplaceRevenueCards({ title, current, unavailable = false }: Props) {
  const visible = [...current]
    .filter((item) => item.grossCents > 0)
    .sort((a, b) => b.grossCents - a.grossCents);

  if (unavailable || visible.length === 0) {
    return (
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
        <div className="rounded-lg border border-dashed border-gray-200 bg-white p-6 text-sm text-gray-500">
          {unavailable
            ? "Período ainda não processado — veja o aviso acima."
            : "Nenhum faturamento por marketplace encontrado."}
        </div>
      </section>
    );
  }

  return (
    <section className="mt-8">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
        {visible.map((item) => (
          <div key={item.source} className="rounded-lg border border-gray-200 bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
              {formatOriginLabel(item.source)}
            </p>
            <p className="mt-2 text-xl font-semibold tabular-nums text-gray-900">
              {formatBRL(item.grossCents)}
            </p>
            <p className="mt-1 text-xs text-gray-400">{formatCount(item.transactionCount, item.basis)}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
