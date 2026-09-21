import { unstable_cache } from "next/cache";

import { JOB_EXPECTATIONS, JOB_NAMES, type JobExpectation } from "@/features/integration/job-names";
import { listLatestJobRuns, type JobRunRow } from "@/features/integration/job-run-repository";
import {
  getPipelineStatus,
  type PipelineStatus,
} from "@/features/integration/shopify-payment-resolution-repository";
import {
  buildVerificationView,
  type VerificationView,
} from "@/features/integration/verification-run-view";
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

/**
 * `crit` existe porque o ambar estava fazendo dois trabalhos.
 *
 * Antes, "o dia ainda esta drenando a fila" e "nenhum mecanismo automatico
 * alcanca este pedido" saiam com a mesma cor. Quem olha o painel todo dia
 * aprende a ignorar um ambar que quase sempre significa espera — e junto com
 * ele passa a ignorar o caso que exige alguem agir.
 *
 * Por isso `crit` e' escasso por definicao: so entra onde nenhuma rodada
 * seguinte resolve sozinha. Ambar continua sendo "espere e olhe de novo";
 * vermelho e' "ninguem vai consertar isto sem voce". Diluir essa fronteira
 * devolve o painel ao estado em que tudo tem a mesma urgencia, ou seja,
 * nenhuma.
 */
type Tone = "ok" | "warn" | "crit" | "unknown";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/20",
  crit: "bg-red-50 text-red-700 ring-red-600/20",
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

  // Sai da mesma leitura de job_runs que o bloco de execucoes ja fez: o recibo
  // da verificacao esta no `result` daquela linha. Nenhuma consulta a mais.
  const verificacao =
    runs === null
      ? null
      : buildVerificationView(runs.find((run) => run.job_name === JOB_NAMES.shopifyVerify));

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
      <VerificacaoCard view={verificacao} />
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

  // Os dois casos sao `crit`, e nao `warn`, porque nenhuma rodada seguinte os
  // desfaz sozinha. `staleAfterMinutes` ja embute ~30% de folga sobre o
  // intervalo do cron: passar disso nao e' atraso, e' agendamento quebrado.
  // E uma falha registrada e' passado — em 09/09/2026 o shopify-verify falhou e
  // ficou 12 dias sem ninguem notar, com o painel mostrando o mesmo ambar de
  // "aguarde" que ele mostra em dia imaturo.
  const tone: Tone =
    run.status === "failed" || atrasado ? "crit" : run.status === "ok" ? "ok" : "unknown";

  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-gray-800">{esperado.label}</p>
        <p className="text-[11px] text-gray-500">
          {instante(run.started_at)} · {descreverIdade(idade)}
          {run.duration_ms !== null && ` · ${(run.duration_ms / 1000).toFixed(1)}s`}
        </p>
        {run.error_message && (
          // Acompanha o badge: se a execucao falhou, o badge e' `crit` e a
          // mensagem nao pode ficar num tom mais brando que ele.
          <p className="mt-0.5 truncate text-[11px] text-red-700" title={run.error_message}>
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

/**
 * Recibo da ultima verificacao contra a Shopify.
 *
 * Responde literalmente "quantos pedidos faltam ser reconciliados", que o bloco
 * de cima nao respondia: la a coluna "sem rateio" so enxerga pedido sem NENHUMA
 * perna no ledger. Um pedido com perna de valor errado — captura que chegou
 * depois — conta como reconciliado ali, e so aparece aqui.
 *
 * A regra de exibicao esta em verification-run-view.ts: enquanto o dia nao
 * fecha, o desvio e' apresentado como parcial, nunca como veredito.
 */
const VERIFICACAO_ROTULO: Record<VerificationView["status"], { texto: string; tone: Tone }> = {
  sem_registro: { texto: "sem registro", tone: "unknown" },
  // A execucao lancou: nao ha relatorio do dia, e a proxima rodada so vem
  // amanha. Nao ha nada a esperar, entao e' `crit`.
  falhou: { texto: "falhou", tone: "crit" },
  formato_desconhecido: { texto: "formato não reconhecido", tone: "unknown" },
  provisoria: { texto: "parcial", tone: "unknown" },
  conferido: { texto: "confere", tone: "ok" },
  // Dia MADURO e ainda divergindo — a fila ja drenou, entao o numero e' desvio
  // de verdade e nao espera. `provisoria` continua cinza justamente para que
  // esta linha signifique alguma coisa.
  divergente: { texto: "diverge", tone: "crit" },
};

function VerificacaoCard({ view }: { view: VerificationView | null }) {
  if (view === null || view.status === "sem_registro") {
    return (
      <Card title="Verificação contra a Shopify">
        <SemDado motivo="a verificação ainda não deixou registro" />
      </Card>
    );
  }

  const rotulo = VERIFICACAO_ROTULO[view.status];
  const ledger = view.ledgerVsShopify;
  const provisoria = view.status === "provisoria";

  return (
    <Card
      title="Verificação contra a Shopify"
      hint="Recibo do último dia verificado (D-1). O desvio compara o ledger de rateio com o que a Shopify diz ter recebido, pedido a pedido."
    >
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={rotulo.tone}>{rotulo.texto}</Badge>
        <span className="text-[11px] text-gray-500">
          {view.date ? `dia ${view.date}` : "dia não identificado"} · verificado em{" "}
          {instante(view.ranAt)}
        </span>
      </div>

      {view.errorMessage && (
        <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
          {view.errorMessage}
        </p>
      )}

      {/* O aviso vem ANTES dos numeros de proposito: quem bate o olho no valor e
          sai da tela precisa ter lido que ele ainda esta se movendo. */}
      {provisoria && view.pendencias.length > 0 && (
        <div className="mb-3 rounded border border-dashed border-gray-300 bg-gray-50 px-3 py-2">
          <p className="text-[11px] font-medium text-gray-700">
            Números parciais — o dia ainda não fechou:
          </p>
          <ul className="mt-1 list-inside list-disc text-[11px] text-gray-600">
            {view.pendencias.map((pendencia) => (
              <li key={pendencia}>{pendencia}</li>
            ))}
          </ul>
        </div>
      )}

      {ledger === null ? (
        <SemDado motivo="a execução não registrou a comparação com a Shopify" />
      ) : (
        <dl className="grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-4">
          <div>
            <dt className="text-gray-500">Desvio</dt>
            <dd
              className={`text-sm font-semibold ${
                provisoria
                  ? "text-gray-500"
                  : ledger.divergentOrders > 0
                    ? "text-amber-700"
                    : "text-gray-800"
              }`}
            >
              {ledger.driftFormatted}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Pedidos a reconciliar</dt>
            <dd
              className={`text-sm font-semibold ${
                provisoria
                  ? "text-gray-500"
                  : ledger.divergentOrders > 0
                    ? "text-amber-700"
                    : "text-gray-800"
              }`}
            >
              {ledger.divergentOrders.toLocaleString("pt-BR")}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Pedidos comparados</dt>
            <dd className="text-sm font-semibold text-gray-800">
              {ledger.comparedOrders.toLocaleString("pt-BR")}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Ponto cego declarado</dt>
            <dd className="text-sm font-semibold text-gray-800">{ledger.blindSpotFormatted}</dd>
          </div>
        </dl>
      )}

      {view.metricasDivergentes.length > 0 && (
        <div className="mt-3 border-t border-gray-100 pt-3">
          <p className="text-[11px] font-medium text-gray-700">
            Sistema × ledger — o que a tela mostra contra o que foi reconciliado:
          </p>
          <ul className="mt-1 space-y-0.5">
            {view.metricasDivergentes.map((metrica) => (
              <li key={metrica.label} className="flex justify-between gap-3 text-[11px]">
                <span className="min-w-0 truncate text-gray-600">{metrica.label}</span>
                <span className={`shrink-0 font-medium ${provisoria ? "text-gray-500" : "text-amber-700"}`}>
                  {metrica.diff} ({metrica.diffPct})
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {ledger !== null && ledger.ordersOnlyInLedger > 0 && (
        <p className="mt-2 text-[11px] text-gray-500">
          O ponto cego são {ledger.ordersOnlyInLedger.toLocaleString("pt-BR")} pedido(s) pagos 100%
          com crédito na loja. A Shopify não emite tender transaction para esse meio, então essas
          pernas ficam fora da comparação em vez de virarem divergência permanente.
        </p>
      )}

      <ReconciliacaoBloco reconciliacao={view.reconciliacao} />
    </Card>
  );
}

/**
 * O que a reconciliacao fez na ultima rodada, e o que ficou em aberto.
 *
 * Fica DENTRO do card da verificacao, e nao num card proprio, porque a mesma
 * execucao produz os dois: o desvio acima e' o que foi medido, isto e' o que foi
 * feito a respeito. Separar em dois cards sugeriria duas rotinas independentes.
 *
 * `persistentes` e `semCorrecao` ganham destaque proprio mesmo valendo zero na
 * maior parte dos dias: sao os numeros que nao se resolvem sozinhos com o
 * tempo. Os outros dois descrevem uma rodada; estes dois descrevem uma divida.
 *
 * `semCorrecao` e' o mais grave dos dois e era o unico que nao aparecia aqui.
 * Persistente ja esteve corrigido e voltou a divergir — ha o que investigar,
 * mas o mecanismo ao menos alcanca o pedido. Sem correcao significa que a
 * re-resolucao RODOU contra a Admin API e o ledger continuou discordando: o
 * automatico ja fez o que sabia fazer.
 */
function ReconciliacaoBloco({
  reconciliacao,
}: {
  reconciliacao: VerificationView["reconciliacao"];
}) {
  if (reconciliacao === null) return null;

  if (reconciliacao.erro !== null) {
    return (
      <p className="mt-3 border-t border-gray-100 pt-3 text-[11px] text-amber-800">
        A medição acima correu bem, mas a reconciliação falhou: {reconciliacao.erro}
      </p>
    );
  }

  const { corrigidos, pendentes, persistentes, semCorrecao, detectadas, diaAdiado } = reconciliacao;

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <p className="text-[11px] font-medium text-gray-700">
        Reconciliação por pedido (D-1 a D-3)
      </p>
      <dl className="mt-1 grid grid-cols-2 gap-3 text-[11px] sm:grid-cols-5">
        <div>
          <dt className="text-gray-500">Detectadas</dt>
          <dd className="text-sm font-semibold text-gray-800">
            {detectadas.toLocaleString("pt-BR")}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Corrigidas</dt>
          <dd className="text-sm font-semibold text-gray-800">
            {corrigidos.toLocaleString("pt-BR")}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Em aberto</dt>
          <dd
            className={`text-sm font-semibold ${pendentes > 0 ? "text-amber-700" : "text-gray-800"}`}
          >
            {pendentes.toLocaleString("pt-BR")}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Persistentes</dt>
          <dd
            className={`text-sm font-semibold ${
              persistentes > 0 ? "text-red-700" : "text-gray-800"
            }`}
          >
            {persistentes.toLocaleString("pt-BR")}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500">Sem correção</dt>
          <dd
            className={`text-sm font-semibold ${
              semCorrecao > 0 ? "text-red-700" : "text-gray-800"
            }`}
          >
            {semCorrecao.toLocaleString("pt-BR")}
          </dd>
        </div>
      </dl>

      {(semCorrecao > 0 || persistentes > 0) && (
        <p className="mt-2 text-[11px] text-red-700">
          Nenhum mecanismo automático fecha esses pedidos: a re-resolução já rodou contra a Shopify
          e o ledger continuou discordando. Listagem por pedido em{" "}
          <code className="rounded bg-red-50 px-1">npm run reconcile:shopify -- --listar</code>.
        </p>
      )}

      {diaAdiado !== null && (
        <p className="mt-2 text-[11px] text-gray-500">
          {diaAdiado} ficou de fora desta rodada: a fila do dia ainda não drenou, e desvio de dia
          imaturo é trabalho pendente, não divergência.
        </p>
      )}

      {persistentes > 0 && (
        <p className="mt-2 text-[11px] text-gray-500">
          Persistente é o pedido que já foi corrigido e voltou a divergir — não fecha sozinho e
          precisa de análise.
        </p>
      )}
    </div>
  );
}
