import "dotenv/config";

import { Pool } from "pg";

import { JOB_EXPECTATIONS } from "../src/features/integration/job-names";

/**
 * Relatorio de execucao das crons em producao, lido de integration.job_runs.
 *
 * Por que existe: o painel de /integracoes responde "como esta agora" — ele le a
 * ULTIMA execucao de cada job. Nenhuma tela responde "como foi a semana", que e'
 * a pergunta de acompanhamento: a cadencia realizada bateu com a agendada, o
 * tempo de execucao esta encostando no maxDuration da rota, houve falha que se
 * curou sozinha na rodada seguinte e por isso sumiu do painel.
 *
 * As expectativas (cadencia e tolerancia) vem de JOB_EXPECTATIONS, e nao de
 * numeros repetidos aqui. Se a agenda mudar em wrangler.jsonc, muda la e este
 * relatorio acompanha — duas listas divergentes fariam o relatorio acusar
 * "faltou execucao" para um job que roda exatamente como foi agendado.
 *
 * Uso:
 *   npm run report:crons            # janela padrao de 7 dias
 *   npm run report:crons -- --days=14
 *
 * Somente leitura: nao escreve nada, pode rodar contra producao a vontade.
 */

const DEFAULT_DAYS = 7;

/**
 * Teto declarado em `export const maxDuration` de cada rota de cron. Serve para
 * o relatorio dizer o quanto da folga ja foi consumida — um pico em 80% do teto
 * e' o aviso que antecede o corte silencioso no meio da execucao.
 */
const MAX_DURATION_SECONDS: Record<string, number> = {
  "worker-sync": 300,
  "materialize-orders": 300,
  "shopify-payment-resolution": 300,
  "shopify-verify": 300,
};

type AgregadoRow = {
  job_name: string;
  execucoes: number;
  ok: number;
  falhas: number;
  presas: number;
  media_ms: number | null;
  p95_ms: number | null;
  pico_ms: number | null;
  maior_gap_min: number | null;
  ultima: Date | null;
  agendadas: number;
  manuais: number;
};

type FalhaRow = {
  job_name: string;
  started_at: Date;
  status: string;
  duration_ms: number | null;
  error_message: string | null;
};

function parseDays(argv: string[]): number {
  const flag = argv.find((arg) => arg.startsWith("--days="));
  if (!flag) return DEFAULT_DAYS;
  const parsed = Number(flag.slice("--days=".length));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DAYS;
  return Math.floor(parsed);
}

function brt(value: Date | null): string {
  if (!value) return "—";
  return value.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

function segundos(ms: number | null): string {
  if (ms === null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

async function main(): Promise<void> {
  const days = parseDays(process.argv.slice(2));
  const connectionString = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

  if (!connectionString) {
    console.error("CORE_DB_URL (ou DATABASE_URL) nao configurada.");
    process.exit(1);
  }

  const pool = new Pool({ connectionString, max: 2, statement_timeout: 30_000 });

  try {
    /*
     * Uma unica varredura da janela alimenta todas as metricas.
     *
     * `agendadas` x `manuais` separa pelo prefixo que o Worker poe no
     * x-request-id (`cf-cron-<timestamp>`). Sem essa separacao a contagem
     * mente nos dois sentidos: um disparo manual de teste inflava o dia e
     * escondia uma execucao agendada que faltou.
     *
     * O maior intervalo entre execucoes consecutivas e' o que se compara com
     * `staleAfterMinutes` — a media esconde exatamente o buraco que interessa.
     */
    const { rows: agregado } = await pool.query<AgregadoRow>(
      `WITH janela AS (
         SELECT job_name, started_at, status, duration_ms, request_id,
                lag(started_at) OVER (PARTITION BY job_name ORDER BY started_at) AS anterior
           FROM integration.job_runs
          WHERE started_at >= NOW() - make_interval(days => $1::int)
       )
       SELECT job_name,
              count(*)::int AS execucoes,
              count(*) FILTER (WHERE status = 'ok')::int AS ok,
              count(*) FILTER (WHERE status = 'failed')::int AS falhas,
              count(*) FILTER (WHERE status = 'running')::int AS presas,
              count(*) FILTER (WHERE request_id LIKE 'cf-cron-%')::int AS agendadas,
              count(*) FILTER (WHERE request_id NOT LIKE 'cf-cron-%'
                                  OR request_id IS NULL)::int AS manuais,
              round(avg(duration_ms) FILTER (WHERE status = 'ok'))::int AS media_ms,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)
                FILTER (WHERE status = 'ok') AS p95_ms,
              max(duration_ms) FILTER (WHERE status = 'ok') AS pico_ms,
              round(max(EXTRACT(EPOCH FROM (started_at - anterior)) / 60))::int AS maior_gap_min,
              max(started_at) AS ultima
         FROM janela
        GROUP BY job_name`,
      [days]
    );

    const { rows: falhas } = await pool.query<FalhaRow>(
      `SELECT job_name, started_at, status, duration_ms, error_message
         FROM integration.job_runs
        WHERE status <> 'ok'
          AND started_at >= NOW() - make_interval(days => $1::int)
        ORDER BY started_at DESC
        LIMIT 50`,
      [days]
    );

    const porNome = new Map(agregado.map((linha) => [linha.job_name, linha]));

    console.log(`\nExecucao das crons — ultimos ${days} dias (fonte: integration.job_runs)\n`);

    let problemas = 0;

    for (const esperado of JOB_EXPECTATIONS) {
      const linha = porNome.get(esperado.name);
      console.log(`## ${esperado.label} (${esperado.name})`);

      // Ausencia total de linha nao e' zero execucoes: pode ser um job renomeado
      // ou um registro que nunca chegou a gravar. Sai como aviso, nao como "ok".
      if (!linha) {
        console.log("   SEM REGISTRO na janela — investigar antes de concluir qualquer coisa.\n");
        problemas += 1;
        continue;
      }

      const esperadas = esperado.expectedPerDay * days;
      const cobertura = ((linha.agendadas / esperadas) * 100).toFixed(0);
      const teto = MAX_DURATION_SECONDS[esperado.name];
      const usoDoTeto =
        linha.pico_ms !== null && teto ? ` (${((linha.pico_ms / 1000 / teto) * 100).toFixed(0)}% do maxDuration)` : "";

      console.log(`   agendadas   ${linha.agendadas} de ${esperadas} esperadas (${cobertura}%)`);
      if (linha.manuais > 0) {
        console.log(`   manuais     ${linha.manuais} (fora do cron; nao contam para a cadencia)`);
      }
      console.log(`   resultado   ${linha.ok} ok · ${linha.falhas} falhas · ${linha.presas} presas em running`);
      console.log(
        `   duracao     media ${segundos(linha.media_ms)} · p95 ${segundos(linha.p95_ms)} · pico ${segundos(linha.pico_ms)}${usoDoTeto}`
      );
      console.log(
        `   maior vao   ${linha.maior_gap_min ?? "—"} min (tolerancia ${esperado.staleAfterMinutes} min)`
      );
      console.log(`   ultima      ${brt(linha.ultima)}`);

      if (linha.falhas > 0) problemas += 1;
      if (linha.presas > 0) problemas += 1;
      if (linha.maior_gap_min !== null && linha.maior_gap_min > esperado.staleAfterMinutes) {
        console.log(`   ATRASO      maior vao passou da tolerancia`);
        problemas += 1;
      }
      console.log();
    }

    if (falhas.length > 0) {
      console.log("## Falhas e execucoes presas\n");
      for (const falha of falhas) {
        console.log(
          `   ${brt(falha.started_at)} · ${falha.job_name} · ${falha.status} · ${segundos(falha.duration_ms)}`
        );
        if (falha.error_message) console.log(`      ${falha.error_message.slice(0, 200)}`);
      }
      console.log();
    }

    console.log(problemas === 0 ? "Nenhum problema de execucao na janela.\n" : `${problemas} ponto(s) a investigar.\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
