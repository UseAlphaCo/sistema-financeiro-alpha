/**
 * Nomes estaveis dos jobs de cron e a cadencia esperada de cada um.
 *
 * Modulo puro, sem dependencia de banco: e' consumido tanto pelas rotas de cron
 * (que gravam em integration.job_runs) quanto pelo painel de /integracoes, que
 * pede aqui o veredito de saude de cada job (assessPipelineHealth, no fim do
 * arquivo). Um nome divergente entre as duas
 * pontas faria o painel mostrar "nunca rodou" para um job que roda todo dia.
 *
 * A fonte de verdade do agendamento e' `triggers.crons` em
 * cloudflare/worker-sync-cron/wrangler.jsonc. O que esta aqui e' a expectativa
 * derivada dele — se a cadencia mudar la, `expectedEveryMinutes` muda aqui.
 */

export const JOB_NAMES = {
  workerSync: "worker-sync",
  materializeOrders: "materialize-orders",
  shopifyPaymentResolution: "shopify-payment-resolution",
  shopifyVerify: "shopify-verify",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export type JobExpectation = {
  name: JobName;
  label: string;
  /**
   * Intervalo maximo tolerado entre execucoes, em minutos.
   *
   * Nao e' o intervalo do cron: e' o intervalo mais a folga. Um job de 3 em 3
   * horas com tolerancia de 180 min acusaria atraso a cada pequeno deslize de
   * horario do Cloudflare. A folga adotada e' ~30% do intervalo, com minimo de
   * 30 min.
   */
  staleAfterMinutes: number;
  /** Execucoes esperadas em 24 h, para conferir contra o que foi registrado. */
  expectedPerDay: number;
  /**
   * `maxDuration` da rota do job, em segundos. Copia do `export const
   * maxDuration` em src/app/api/internal/cron/<job>/route.ts — um teste trava a
   * paridade.
   *
   * E' o que separa `running` legitimo de `running` travado: a Vercel mata a
   * funcao nesse limite sem dar chance ao `finishJobRun`, entao uma linha que
   * passou dele sem terminar nunca mais vai terminar.
   */
  maxDurationSeconds: number;
};

// Derivado de triggers.crons em wrangler.jsonc, em 09/09/2026:
//   "0 1,4,7,10,13,16,19,22 * * *"  -> worker-sync                 (8/dia)
//   "0 */2 * * *" + "15 13 * * *"   -> shopify-payment-resolution  (13/dia)
//   "50 13 * * *"                   -> shopify-verify              (1/dia)
//   "0 2", "30 10", "40 13", "30 2" -> materialize-orders          (4/dia)
export const JOB_EXPECTATIONS: JobExpectation[] = [
  {
    name: JOB_NAMES.workerSync,
    label: "Sync OMS → mirror",
    staleAfterMinutes: 240,
    expectedPerDay: 8,
    maxDurationSeconds: 60,
  },
  {
    name: JOB_NAMES.materializeOrders,
    label: "Materialização de pedidos",
    // O maior intervalo entre passes e' o das 10:40 BRT para as 23:00 BRT,
    // ou seja ~12 h20. A tolerancia acompanha o maior vao, nao a media.
    staleAfterMinutes: 900,
    expectedPerDay: 4,
    maxDurationSeconds: 300,
  },
  {
    name: JOB_NAMES.shopifyPaymentResolution,
    label: "Resolução de gateway Shopify",
    // 13 e nao 12: alem do passe de 2 em 2 horas ha o das 10:15 BRT, que existe
    // para drenar a fila antes da materializacao de fechamento. O maior vao
    // continua sendo 2 h, entao a tolerancia nao muda.
    staleAfterMinutes: 180,
    expectedPerDay: 13,
    maxDurationSeconds: 300,
  },
  {
    name: JOB_NAMES.shopifyVerify,
    label: "Verificação contra a Shopify",
    staleAfterMinutes: 1560,
    expectedPerDay: 1,
    maxDurationSeconds: 300,
  },
];

// ─── Watchdog: veredito de saude por job ──────────────────────────────────────
//
// Por que mora aqui, e nao no componente: em 09/09/2026 o shopify-verify falhou,
// a falha ficou registrada em integration.job_runs e passou 12 dias sem ninguem
// notar. A decisao de "isto esta errado" vivia embutida no JSX, onde nao dava
// para testar e nao dava para reaproveitar. Isolada numa funcao pura, plugar um
// canal de saida depois (e-mail, Slack, um cron externo que chama a rota) vira
// uma chamada, e nao um refactor.
//
// A ressalva continua valendo: um watchdog que so fala pelo painel nao detecta a
// propria morte. Se a Vercel cair, o painel cai junto.

/** Recorte de uma linha de job_runs. Estrutural para este modulo seguir sem banco. */
export type JobRunSnapshot = {
  /** `Date` direto do driver ou string ISO depois do cache em JSON. */
  started_at: string | Date;
  status: string;
  error_message: string | null;
  request_id: string | null;
};

/**
 * Prefixo que o Worker do Cloudflare poe no `x-request-id` de toda chamada
 * agendada (cloudflare/worker-sync-cron/src/index.ts). E' o mesmo criterio de
 * scripts/report-cron-runs.ts.
 */
export const SCHEDULED_REQUEST_ID_PREFIX = "cf-cron-";

/**
 * A execucao veio do agendador, e nao de um disparo manual?
 *
 * O watchdog vigia o AGENDADOR, entao so estas contam para o veredito. Contar
 * disparo manual esconderia justamente o pior caso: se os cron triggers pararem
 * e alguem rodar o job a mao para testar, a execucao manual zeraria o atraso e
 * completaria a contagem — e o painel diria "ok" com o agendador morto.
 */
export function isScheduledRun(run: Pick<JobRunSnapshot, "request_id">): boolean {
  return run.request_id?.startsWith(SCHEDULED_REQUEST_ID_PREFIX) ?? false;
}

export type JobVerdict =
  /** A ultima execucao terminou em erro. */
  | "falhou"
  /** A ultima execucao passou do `maxDuration` da rota sem terminar. */
  | "travado"
  /** A ultima execucao comecou ha mais tempo que a tolerancia do job. */
  | "atrasado"
  /** Rodou em dia, mas menos vezes que o esperado nas ultimas 24 h. */
  | "poucas_execucoes"
  /** A ultima foi bem, mas outra execucao das ultimas 24 h falhou ou morreu. */
  | "falhas_recentes"
  /** Comecou ha pouco e ainda esta dentro do limite da rota. */
  | "rodando"
  | "ok"
  /** Nenhuma execucao agendada: o job nunca rodou pelo cron desde que o registro existe. */
  | "sem_registro";

/**
 * Mesmos quatro tons do painel, com a mesma doutrina: `crit` so onde nenhuma
 * rodada seguinte resolve sozinha.
 */
export type HealthSeverity = "ok" | "warn" | "crit" | "unknown";

/**
 * `atrasado` e `travado` sao `crit` porque nao se desfazem sozinhos: passar da
 * tolerancia, que ja embute folga sobre o intervalo do cron, e' agendamento
 * quebrado. `poucas_execucoes` e `falhas_recentes` sao `warn`: o job continua
 * rodando e a proxima execucao recupera o dado — mas ha algo a olhar.
 */
const SEVERIDADE: Record<JobVerdict, HealthSeverity> = {
  falhou: "crit",
  travado: "crit",
  atrasado: "crit",
  poucas_execucoes: "warn",
  falhas_recentes: "warn",
  rodando: "ok",
  ok: "ok",
  sem_registro: "unknown",
};

const ORDEM_SEVERIDADE: HealthSeverity[] = ["crit", "warn", "unknown", "ok"];

/**
 * Janela da contagem contra `expectedPerDay`: 24 h mais 15 min.
 *
 * Sem folga, a contagem cairia um em todo instante entre o aniversario de 24 h de
 * uma execucao e o inicio da execucao do dia, que atrasa alguns segundos a
 * minutos por jitter do Cloudflare e cold start da Vercel — e o painel piscaria
 * `poucas_execucoes` a cada slot. Os 15 min sao o custo: uma execucao perdida so
 * fica escondida nos 15 min seguintes ao slot que saiu da janela.
 */
export const RUN_COUNT_WINDOW_MINUTES = 24 * 60 + 15;

/**
 * Multiplicador sobre o `maxDuration` para declarar `running` travado.
 *
 * A Vercel mata no limite exato, entao 1x ja seria suficiente em teoria. O dobro
 * absorve diferenca de relogio entre banco e funcao e o tempo de o INSERT inicial
 * acontecer, sem atrasar o diagnostico de forma relevante (2 a 10 min).
 */
const STUCK_FACTOR = 2;

export type JobHealth = {
  name: JobName;
  label: string;
  verdict: JobVerdict;
  severity: HealthSeverity;
  /** Frase curta em pt-BR explicando o veredito, pronta para painel ou alerta. */
  detail: string;
  minutesSinceLastStart: number | null;
  /** Execucoes agendadas iniciadas dentro de RUN_COUNT_WINDOW_MINUTES, inclusive falhas. */
  runsInWindow: number;
  expectedPerDay: number;
  /** Falhas e execucoes mortas na janela, fora a ultima. */
  recentFailures: number;
};

export type PipelineHealth = {
  /** O pior tom entre os jobs. */
  severity: HealthSeverity;
  jobs: JobHealth[];
  /** Os jobs fora de `ok`, do mais grave para o menos. */
  problems: JobHealth[];
};

function paraMs(value: string | Date): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function idadeCurta(minutos: number): string {
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 48) return `${horas} h`;
  return `${Math.floor(horas / 24)} d`;
}

/**
 * Veredito de UM job a partir das execucoes recentes dele.
 *
 * `runs` nao precisa vir ordenado; linhas com data invalida sao ignoradas, e nao
 * tratadas como "agora". Disparos manuais tambem sao ignorados (ver
 * isScheduledRun). A ordem das guardas e' a ordem de gravidade e e' ela que
 * decide o veredito quando varios valem ao mesmo tempo: um job que travou ha dois
 * dias tambem esta atrasado, mas "travado" diz o que fazer, "atrasado" nao.
 */
export function assessJobHealth(
  expectation: JobExpectation,
  runs: readonly JobRunSnapshot[],
  now: Date
): JobHealth {
  const agora = now.getTime();
  const travadoAposMin = Math.ceil((expectation.maxDurationSeconds * STUCK_FACTOR) / 60);

  const validas = runs
    .filter(isScheduledRun)
    .map((run) => ({ run, inicioMs: paraMs(run.started_at) }))
    .filter((item) => !Number.isNaN(item.inicioMs))
    .sort((a, b) => b.inicioMs - a.inicioMs);

  const base = {
    name: expectation.name,
    label: expectation.label,
    expectedPerDay: expectation.expectedPerDay,
  };

  if (validas.length === 0) {
    return {
      ...base,
      verdict: "sem_registro",
      severity: SEVERIDADE.sem_registro,
      detail: "nenhuma execução agendada registrada",
      minutesSinceLastStart: null,
      runsInWindow: 0,
      recentFailures: 0,
    };
  }

  const idadeMin = (inicioMs: number) => Math.max(0, Math.floor((agora - inicioMs) / 60_000));
  const morta = (item: (typeof validas)[number]) =>
    item.run.status === "failed" ||
    (item.run.status === "running" && idadeMin(item.inicioMs) > travadoAposMin);

  const [ultima, ...anteriores] = validas;
  const minutosDesdeUltima = idadeMin(ultima.inicioMs);
  const naJanela = validas.filter((item) => idadeMin(item.inicioMs) <= RUN_COUNT_WINDOW_MINUTES);
  const falhasRecentes = anteriores.filter(
    (item) => idadeMin(item.inicioMs) <= RUN_COUNT_WINDOW_MINUTES && morta(item)
  ).length;

  const medidas = {
    minutesSinceLastStart: minutosDesdeUltima,
    runsInWindow: naJanela.length,
    recentFailures: falhasRecentes,
  };

  const veredito = (verdict: JobVerdict, detail: string): JobHealth => ({
    ...base,
    ...medidas,
    verdict,
    severity: SEVERIDADE[verdict],
    detail,
  });

  if (ultima.run.status === "failed") {
    const motivo = ultima.run.error_message ? `: ${ultima.run.error_message}` : "";
    return veredito("falhou", `última execução falhou há ${idadeCurta(minutosDesdeUltima)}${motivo}`);
  }

  if (ultima.run.status === "running" && minutosDesdeUltima > travadoAposMin) {
    return veredito(
      "travado",
      `começou há ${idadeCurta(minutosDesdeUltima)} e não terminou; a rota é encerrada em ` +
        `${expectation.maxDurationSeconds} s, então a execução morreu sem registrar o fim`
    );
  }

  if (minutosDesdeUltima > expectation.staleAfterMinutes) {
    return veredito(
      "atrasado",
      `última execução há ${idadeCurta(minutosDesdeUltima)}; tolerância de ` +
        `${idadeCurta(expectation.staleAfterMinutes)}`
    );
  }

  if (naJanela.length < expectation.expectedPerDay) {
    return veredito(
      "poucas_execucoes",
      `${naJanela.length} de ${expectation.expectedPerDay} execuções esperadas nas últimas 24 h`
    );
  }

  if (falhasRecentes > 0) {
    return veredito(
      "falhas_recentes",
      `${falhasRecentes} execução(ões) falharam ou morreram nas últimas 24 h`
    );
  }

  if (ultima.run.status === "running") {
    return veredito("rodando", `em execução há ${idadeCurta(minutosDesdeUltima)}`);
  }

  return veredito("ok", `última execução há ${idadeCurta(minutosDesdeUltima)}`);
}

/**
 * Veredito consolidado do pipeline.
 *
 * Todo job esperado entra, tenha linha ou nao: um job ausente do mapa vira
 * `sem_registro`, e nao some da conta. Sumir seria o silencio indistinguivel de
 * sucesso que esta funcao existe para acabar.
 */
export function assessPipelineHealth(
  runsByJob: ReadonlyMap<string, readonly JobRunSnapshot[]>,
  now: Date,
  expectations: readonly JobExpectation[] = JOB_EXPECTATIONS
): PipelineHealth {
  const jobs = expectations.map((expectation) =>
    assessJobHealth(expectation, runsByJob.get(expectation.name) ?? [], now)
  );

  const posicao = (severity: HealthSeverity) => ORDEM_SEVERIDADE.indexOf(severity);
  const problems = jobs
    .filter((job) => job.severity !== "ok")
    .sort((a, b) => posicao(a.severity) - posicao(b.severity));

  return {
    severity: problems[0]?.severity ?? "ok",
    jobs,
    problems,
  };
}

/**
 * Texto de alerta, ou `null` quando nao ha o que alertar.
 *
 * So `crit` alerta. `warn` e `unknown` ficam no painel: um canal de saida que
 * dispara por "rodou 7 de 8 vezes" treina quem recebe a ignora-lo, e ai o
 * `falhou` de verdade chega junto com o ruido. Nenhum canal consome isto ainda;
 * existe para que ligar um seja uma linha.
 */
export function pipelineAlertText(health: PipelineHealth): string | null {
  const criticos = health.problems.filter((job) => job.severity === "crit");
  if (criticos.length === 0) return null;
  return `Pipeline com problema: ${criticos.map((job) => `${job.label} — ${job.detail}`).join("; ")}`;
}
