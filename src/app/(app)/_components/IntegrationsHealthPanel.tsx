import { unstable_cache } from "next/cache";

import { JOB_EXPECTATIONS, type JobExpectation } from "@/features/integration/job-names";
import { listLatestJobRuns, type JobRunRow } from "@/features/integration/job-run-repository";
import {
  getPipelineStatus,
  type PipelineStatus,
} from "@/features/integration/shopify-payment-resolution-repository";
import { getSyncSweepStatus } from "@/features/integration/worker-sync-jobs";
import { formatMoment } from "@/features/transactions/read-model-freshness";
import type { SweepStatus } from "@/workers/sync/repositories/core-repository";

/**
 * Painel de saude do pipeline, visivel so para admin.
 *
 * Por que existe: em 08/09/2026 o passe D-1 da materializacao das 11:05 BRT nao
 * produziu escrita nenhuma, 6 pedidos de 07/09 (R$ 2.125,23) ficaram fora da
 * tela "Ontem" o dia inteiro, e nada no sistema registrou isso. Pior: o unico
 * sinal disponivel na epoca, `max(materialized_at)`, NAO distingue "rodou e nada
 * mudou" de "nao rodou", porque o UPSERT tem guard de content_hash. O painel
 * existe para que essa pergunta tenha resposta em um lugar so.
 *
 * Regra de leitura deste painel: **null nunca vira zero**. Uma fonte que falhou
 * mostra "sem dado", nunca um numero tranquilizador. E' a mesma regra que
 * read-model-freshness.ts aplica nas telas de valor, pelo mesmo motivo: um zero
 * mudo le-se como "esta tudo bem".
 */

const MINUTE_MS = 60_000;

type Tone = "ok" | "warn" | "unknown";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/20",
  unknown: "bg-gray-100 text-gray-600 ring-gray-500/20",
};

function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${TONE_CLASS[tone]}`}
    >
      {children}
    </span>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4">
      <header className="mb-3">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

/** Traco, e nao zero: ausencia de dado precisa parecer ausencia de dado. */
function SemDado({ motivo }: { motivo: string }) {
  return (
    <p className="rounded border border-dashed border-gray-300 px-3 py-4 text-center text-xs text-gray-500">
      — {motivo}
    </p>
  );
}

function minutosDesde(value: Date | string | null): number | null {
  if (!value) return null;
  const instante = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instante.getTime())) return null;
  return Math.floor((Date.now() - instante.getTime()) / MINUTE_MS);
}

function descreverIdade(minutos: number | null): string {
  if (minutos === null) return "sem data";
  if (minutos < 1) return "agora";
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  return `há ${Math.floor(horas / 24)} d`;
}

function instante(value: Date | string | null): string {
  if (!value) return "—";
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : formatMoment(parsed);
}

/**
 * Recorte do SweepStatus com instantes ja em ISO.
 *
 * Existe por causa do cache: unstable_cache serializa em JSON, entao um `Date`
 * volta como string e o tipo original passaria a mentir sobre o que chega em
 * runtime. Normalizar na entrada mantem o tipo honesto.
 */
type SweepView = {
  pendingRepair: number;
  lastCycleAt: string | null;
  okCyclesLast24h: number;
  sources: { source: string; mirrorRows: number; lastReceivedAt: string | null }[];
};

function toSweepView(sweep: SweepStatus): SweepView {
  return {
    pendingRepair: sweep.pendingRepair,
    lastCycleAt: sweep.lastCycleAt?.toISOString() ?? null,
    okCyclesLast24h: sweep.okCyclesLast24h,
    sources: sweep.sources.map((source) => ({
      source: source.source,
      mirrorRows: source.mirrorRows,
      lastReceivedAt: source.lastReceivedAt?.toISOString() ?? null,
    })),
  };
}

/**
 * Carrega cada fonte isoladamente.
 *
 * Promise.allSettled e nao Promise.all: uma fonte quebrada deve virar "sem
 * dado" no seu bloco, nao derrubar o painel inteiro nem, pior, a tela de
 * Integracoes que o admin usa justamente para descobrir o que quebrou.
 */
async function carregar() {
  const [runs, sweep, pipeline] = await Promise.allSettled([
    listLatestJobRuns(),
    getSyncSweepStatus(),
    getPipelineStatus(7),
  ]);

  return {
    runs: runs.status === "fulfilled" ? runs.value : null,
    sweep: sweep.status === "fulfilled" ? toSweepView(sweep.value) : null,
    pipeline: pipeline.status === "fulfilled" ? pipeline.value : null,
  };
}

/**
 * 60 s de cache.
 *
 * Nao e' economia de conforto: getSyncSweepStatus abre e FECHA um pool proprio
 * a cada chamada, e uma conexao fria contra o pooler do Supabase custou 3,2 s
 * medidos em 08/09/2026 (a query em si roda em 13 ms no servidor). Sem cache,
 * cada visita ao painel paga esse handshake.
 */
const carregarComCache = unstable_cache(carregar, ["integrations-health-panel"], {
  revalidate: 60,
});

export default async function IntegrationsHealthPanel() {
  const { runs, sweep, pipeline } = await carregarComCache();

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Saúde do pipeline</h2>
        <p className="text-xs text-gray-500">
          Visível apenas para administradores. Atualiza a cada 60 segundos.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ExecucoesCard runs={runs} />
        <MirrorCard sweep={sweep} />
      </div>

      <PipelineCard pipeline={pipeline} />
    </div>
  );
}

function ExecucoesCard({ runs }: { runs: JobRunRow[] | null }) {
  if (runs === null) {
    return (
      <Card title="Execuções de cron">
        <SemDado motivo="não foi possível ler o registro de execuções" />
      </Card>
    );
  }

  const porNome = new Map(runs.map((run) => [run.job_name, run]));

  return (
    <Card
      title="Execuções de cron"
      hint="Última execução de cada job. Uma execução que rodou sem mudar nada também aparece aqui."
    >
      <ul className="divide-y divide-gray-100">
        {JOB_EXPECTATIONS.map((esperado) => (
          <LinhaExecucao key={esperado.name} esperado={esperado} run={porNome.get(esperado.name)} />
        ))}
      </ul>
    </Card>
  );
}

function LinhaExecucao({ esperado, run }: { esperado: JobExpectation; run: JobRunRow | undefined }) {
  // Sem linha nenhuma nao e' o mesmo que atrasado: pode ser que o job ainda nao
  // tenha rodado uma unica vez desde que o registro passou a existir.
  if (!run) {
    return (
      <li className="flex items-center justify-between gap-3 py-2">
        <span className="text-xs text-gray-700">{esperado.label}</span>
        <Badge tone="unknown">sem registro</Badge>
      </li>
    );
  }

  const idade = minutosDesde(run.started_at);
  const atrasado = idade !== null && idade > esperado.staleAfterMinutes;
  const tone: Tone = run.status === "failed" || atrasado ? "warn" : run.status === "ok" ? "ok" : "unknown";

  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-800">{esperado.label}</p>
        <p className="text-[11px] text-gray-500">
          {instante(run.started_at)} · {descreverIdade(idade)}
          {run.duration_ms !== null && ` · ${(run.duration_ms / 1000).toFixed(1)}s`}
        </p>
        {run.error_message && (
          <p className="mt-0.5 truncate text-[11px] text-amber-700" title={run.error_message}>
            {run.error_message}
          </p>
        )}
      </div>
      <Badge tone={tone}>
        {run.status === "failed" ? "falhou" : atrasado ? "atrasado" : run.status === "running" ? "rodando" : "ok"}
      </Badge>
    </li>
  );
}

function MirrorCard({ sweep }: { sweep: SweepView | null }) {
  if (sweep === null) {
    return (
      <Card title="Mirror e sync">
        <SemDado motivo="não foi possível ler o estado da varredura" />
      </Card>
    );
  }

  // Esperado vem de JOB_EXPECTATIONS e nao de um numero fixo: o docblock de
  // SweepStatus ainda diz "esperado 24 no cron horario", que era verdade quando
  // o sync rodava de hora em hora e deixou de ser quando passou a 3 em 3 h.
  const esperadoPorDia =
    JOB_EXPECTATIONS.find((job) => job.name === "worker-sync")?.expectedPerDay ?? null;
  const ciclosBaixos = esperadoPorDia !== null && sweep.okCyclesLast24h < esperadoPorDia;

  return (
    <Card title="Mirror e sync" hint="Frescor por fonte. Um agregado esconderia uma fonte parada.">
      <ul className="divide-y divide-gray-100">
        {sweep.sources.map((source) => {
          const idade = minutosDesde(source.lastReceivedAt);
          return (
            <li key={source.source} className="flex items-center justify-between gap-3 py-2">
              <div>
                <p className="text-xs font-medium text-gray-800">{source.source}</p>
                <p className="text-[11px] text-gray-500">
                  {instante(source.lastReceivedAt)} · {descreverIdade(idade)} ·{" "}
                  {source.mirrorRows.toLocaleString("pt-BR")} linhas
                </p>
              </div>
              <Badge tone={idade === null ? "unknown" : idade > 240 ? "warn" : "ok"}>
                {idade === null ? "sem data" : descreverIdade(idade)}
              </Badge>
            </li>
          );
        })}
      </ul>

      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-gray-100 pt-3 text-[11px]">
        <div>
          <dt className="text-gray-500">Último ciclo</dt>
          <dd className="font-medium text-gray-800">{instante(sweep.lastCycleAt)}</dd>
        </div>
        <div>
          <dt className="text-gray-500">Ciclos ok (24h)</dt>
          <dd className={`font-medium ${ciclosBaixos ? "text-amber-700" : "text-gray-800"}`}>
            {sweep.okCyclesLast24h}
            {esperadoPorDia !== null && ` / ${esperadoPorDia}`}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">A reparar</dt>
          <dd className="font-medium text-gray-800">{sweep.pendingRepair.toLocaleString("pt-BR")}</dd>
        </div>
      </dl>
    </Card>
  );
}

function PipelineCard({ pipeline }: { pipeline: PipelineStatus | null }) {
  if (pipeline === null) {
    return (
      <Card title="Materialização e reconciliação">
        <SemDado motivo="não foi possível ler o estado do pipeline" />
      </Card>
    );
  }

  const pulso = minutosDesde(pipeline.lastLedgerWriteAt);

  return (
    <Card
      title="Materialização e reconciliação"
      hint="Por dia, do que já foi materializado: quanto ainda não tem rateio no ledger da Shopify."
    >
      <dl className="mb-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
        <div>
          <dt className="text-gray-500">Ledger escreveu</dt>
          <dd className="font-medium text-gray-800">
            {instante(pipeline.lastLedgerWriteAt)} · {descreverIdade(pulso)}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Pagamento mais recente</dt>
          <dd className="font-medium text-gray-800">{instante(pipeline.lastPaymentProcessedAt)}</dd>
        </div>
      </dl>

      {pipeline.days.length === 0 ? (
        <SemDado motivo="nenhum dia materializado na janela" />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 font-medium">Dia</th>
                <th className="px-3 py-2 text-right font-medium">Pedidos</th>
                <th className="px-3 py-2 font-medium">Materializado</th>
                <th className="px-3 py-2 text-right font-medium">Sem resolução</th>
                <th className="px-3 py-2 text-right font-medium">Sem rateio</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {pipeline.days.map((dia) => (
                <tr key={dia.day}>
                  <td className="px-3 py-2 font-medium text-gray-800">{dia.day}</td>
                  <td className="px-3 py-2 text-right text-gray-700">
                    {dia.orders.toLocaleString("pt-BR")}
                  </td>
                  <td className="px-3 py-2 text-gray-600">{instante(dia.lastMaterializedAt)}</td>
                  <td
                    className={`px-3 py-2 text-right ${dia.withoutResolution > 0 ? "font-medium text-amber-700" : "text-gray-500"}`}
                  >
                    {dia.withoutResolution}
                  </td>
                  <td
                    className={`px-3 py-2 text-right ${dia.withoutLedger > 0 ? "font-medium text-amber-700" : "text-gray-500"}`}
                  >
                    {dia.withoutLedger}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 text-[11px] text-gray-500">
        Mede o que já foi materializado. Pedido pago que ainda não virou linha aparece no bloco de
        execuções, não aqui.
      </p>
    </Card>
  );
}
