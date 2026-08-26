import { getMaterializedLag } from "@/features/transactions/financial-orders-repository";
import { resolveCoverage, describeCoverage } from "@/features/transactions/read-model-coverage";
import { resolveFreshness, type Freshness } from "@/features/transactions/read-model-freshness";
import { isMaterializedReadModelEnabled } from "@/shared/read-model-config";

/**
 * Aviso de ate onde os dados vao, para dashboard e fluxo de caixa.
 *
 * Existe porque com FINANCIAL_READ_MODEL_MATERIALIZED ligado as telas leem uma
 * tabela preenchida 1x/dia as 23 h BRT. Sem isto, o preset "Hoje" mostra
 * R$ 0,00 o dia inteiro e quem olha le "nao vendeu nada" -- e nao "ainda nao
 * processamos".
 *
 * Cobre as DUAS pontas: o teto (read-model-freshness.ts, so faz sentido com a
 * flag ligada) e o piso (read-model-coverage.ts, vale para qualquer fonte). O
 * piso ja tinha a frase pronta em describeCoverage e nunca teve chamador.
 */

type Props = {
  /** Periodo ja resolvido, como devolvido por computeCashFlow. */
  period: { startDate: string; endDate: string };
};

/**
 * Estado de frescor do periodo, para a pagina decidir o que exibir.
 *
 * Separado do componente porque a pagina precisa da MESMA resposta para suprimir
 * os totais (`canShowTotals`) -- e chamar getMaterializedLag duas vezes por
 * render seria uma ida ao banco a mais por visita.
 */
export async function getFreshness(period: {
  startDate: string;
  endDate: string;
}): Promise<Freshness | null> {
  // Sem a flag, as telas leem o mirror ao vivo e nao ha teto: avisar defasagem
  // ali seria inventar um problema que aquele caminho nao tem.
  if (!isMaterializedReadModelEnabled()) return null;

  try {
    return resolveFreshness(period, await getMaterializedLag());
  } catch {
    // O aviso e informacao adicional: falhar em obte-lo nao pode derrubar a
    // tela inteira que ja carregou os numeros.
    return null;
  }
}

function Aviso({ tone, children }: { tone: "warn" | "info"; children: React.ReactNode }) {
  const classes =
    tone === "warn"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : "border-gray-200 bg-gray-50 text-gray-600";

  return <p className={`rounded-md border px-3 py-2 text-xs ${classes}`}>{children}</p>;
}

export default function DataFreshnessNotice({
  period,
  freshness,
  className = "",
}: Props & { freshness: Freshness | null; className?: string }) {
  const coverage = resolveCoverage(new Date(period.startDate), new Date(period.endDate));
  const floorMessage = describeCoverage(coverage);

  // `not_yet` e `unknown` sao acionaveis (a tela pode estar vazia por isso);
  // `trailing` e contexto.
  const tone = freshness?.status === "trailing" ? "info" : "warn";

  // Sem nada a dizer, nao renderiza NADA -- nem um wrapper vazio, que deixaria
  // a margem do chamador como espaco morto no topo da tela.
  if (!freshness?.message && !floorMessage) return null;

  return (
    <div className={`space-y-2 ${className}`}>
      {freshness?.message ? <Aviso tone={tone}>{freshness.message}</Aviso> : null}
      {floorMessage ? <Aviso tone="warn">{floorMessage}</Aviso> : null}
    </div>
  );
}
