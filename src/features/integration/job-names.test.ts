import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assessJobHealth,
  assessPipelineHealth,
  JOB_EXPECTATIONS,
  JOB_NAMES,
  pipelineAlertText,
  type JobExpectation,
  type JobRunSnapshot,
} from "./job-names";

/**
 * O watchdog do pipeline, sem banco e sem relogio de parede.
 *
 * O caso que motivou: em 09/09/2026 o shopify-verify falhou, ficou registrado em
 * job_runs e passou 12 dias sem ninguem notar. Cada `it` abaixo e' uma forma de
 * silencio que precisa deixar de parecer sucesso.
 */

const AGORA = new Date("2026-09-23T15:00:00.000Z");
const MIN = 60_000;

/** Job de 3 em 3 h, como o worker-sync: 8/dia, tolerancia 240 min, rota de 60 s. */
const SYNC: JobExpectation = {
  name: JOB_NAMES.workerSync,
  label: "Sync OMS → mirror",
  staleAfterMinutes: 240,
  expectedPerDay: 8,
  maxDurationSeconds: 60,
};

function execucao(
  minutosAtras: number,
  status: string = "ok",
  error_message: string | null = null,
  request_id: string | null = `cf-cron-${AGORA.getTime() - minutosAtras * MIN}`
): JobRunSnapshot {
  return {
    started_at: new Date(AGORA.getTime() - minutosAtras * MIN).toISOString(),
    status,
    error_message,
    request_id,
  };
}

/** Disparo manual: mesmo formato, sem o prefixo que o Worker poe. */
function manual(minutosAtras: number, status: string = "ok"): JobRunSnapshot {
  return execucao(minutosAtras, status, null, "meu258-teste-local");
}

/** Um dia saudavel: 8 execucoes a cada 3 h, a mais recente ha `offset` minutos. */
function diaSaudavel(offset = 30): JobRunSnapshot[] {
  return Array.from({ length: 8 }, (_, i) => execucao(offset + i * 180));
}

describe("assessJobHealth", () => {
  it("dia saudavel e' ok", () => {
    const saude = assessJobHealth(SYNC, diaSaudavel(), AGORA);

    expect(saude.verdict).toBe("ok");
    expect(saude.severity).toBe("ok");
    expect(saude.runsInWindow).toBe(8);
  });

  it("job falhado: a ultima execucao terminou em erro", () => {
    const runs = diaSaudavel();
    runs[0] = execucao(30, "failed", "timeout exceeded when trying to connect");

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("falhou");
    expect(saude.severity).toBe("crit");
    // A mensagem de erro viaja no detalhe: e' o que alguem precisa ler primeiro.
    expect(saude.detail).toContain("timeout exceeded");
  });

  it("job atrasado: a ultima execucao passou da tolerancia", () => {
    const saude = assessJobHealth(SYNC, diaSaudavel(241), AGORA);

    expect(saude.verdict).toBe("atrasado");
    expect(saude.severity).toBe("crit");
  });

  it("no limite exato da tolerancia ainda nao e' atraso", () => {
    expect(assessJobHealth(SYNC, diaSaudavel(240), AGORA).verdict).not.toBe("atrasado");
  });

  it("job com menos execucoes que o esperado, mesmo em dia", () => {
    // A ultima e' recente, entao staleAfterMinutes sozinho diria "ok". So a
    // contagem contra expectedPerDay enxerga os slots perdidos.
    const runs = diaSaudavel().filter((_, i) => i !== 3 && i !== 5);

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("poucas_execucoes");
    expect(saude.severity).toBe("warn");
    expect(saude.runsInWindow).toBe(6);
    expect(saude.detail).toContain("6 de 8");
  });

  it("a janela de contagem tolera o jitter do slot mais antigo", () => {
    // O slot mais antigo comecou ha 24 h e 5 min: o de hoje ainda nao abriu (o
    // cron atrasou uns segundos). Sem a folga, isto piscaria poucas_execucoes.
    const runs = [
      ...Array.from({ length: 7 }, (_, i) => execucao(185 + i * 180)),
      execucao(24 * 60 + 5),
    ];

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.runsInWindow).toBe(8);
    expect(saude.verdict).toBe("ok");
  });

  it("job running travado: passou do maxDuration da rota e nunca terminou", () => {
    // Sem esta regra, o painel so olhava started_at: um job pendurado ha 2 h
    // num intervalo de 3 h aparecia como saudavel.
    const runs = diaSaudavel(150);
    runs.unshift(execucao(120, "running"));

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("travado");
    expect(saude.severity).toBe("crit");
  });

  it("running dentro do limite da rota e' rodando, nao travado", () => {
    const runs = diaSaudavel(180);
    runs.unshift(execucao(1, "running"));

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("rodando");
    expect(saude.severity).toBe("ok");
  });

  it("travado tem precedencia sobre atrasado", () => {
    // Travado ha 2 dias tambem esta atrasado, mas so "travado" diz o que houve.
    const saude = assessJobHealth(SYNC, [execucao(2 * 24 * 60, "running")], AGORA);
    expect(saude.verdict).toBe("travado");
  });

  it("falha anterior na janela aparece mesmo com a ultima execucao ok", () => {
    const runs = diaSaudavel();
    runs[2] = execucao(30 + 2 * 180, "failed", "ECONNRESET");

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("falhas_recentes");
    expect(saude.severity).toBe("warn");
    expect(saude.recentFailures).toBe(1);
  });

  it("execucao antiga que morreu running conta como falha recente", () => {
    // A Vercel mata no maxDuration e a linha fica `running` para sempre. Quando
    // a execucao seguinte roda, a morta deixa de ser a ultima — e sem esta regra
    // sumiria sem deixar sinal.
    const runs = diaSaudavel();
    runs[1] = execucao(30 + 180, "running");

    expect(assessJobHealth(SYNC, runs, AGORA).recentFailures).toBe(1);
  });

  it("falha fora da janela de 24 h nao pesa", () => {
    const runs = [...diaSaudavel(), execucao(30 * 60, "failed")];
    expect(assessJobHealth(SYNC, runs, AGORA).verdict).toBe("ok");
  });

  it("disparo manual nao esconde o agendador parado", () => {
    // O pior caso: os cron triggers pararam ha 10 h, e alguem rodou o job a mao
    // ha 5 min para testar. Contando o manual, o painel diria "ok".
    const runs = [manual(5), ...diaSaudavel(600)];

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("atrasado");
    expect(saude.minutesSinceLastStart).toBe(600);
  });

  it("disparo manual nao completa a contagem nem vira falha do job", () => {
    const agendadas = diaSaudavel().slice(0, 7);
    const runs = [manual(10, "failed"), manual(20), ...agendadas];

    const saude = assessJobHealth(SYNC, runs, AGORA);

    expect(saude.verdict).toBe("poucas_execucoes");
    expect(saude.runsInWindow).toBe(7);
  });

  it("request_id nulo conta como manual", () => {
    // Execucao sem request_id nao veio do Worker, que sempre manda um.
    expect(assessJobHealth(SYNC, [execucao(5, "ok", null, null)], AGORA).verdict).toBe(
      "sem_registro"
    );
  });

  it("sem nenhuma linha e' sem_registro, nao ok nem atrasado", () => {
    const saude = assessJobHealth(SYNC, [], AGORA);

    expect(saude.verdict).toBe("sem_registro");
    expect(saude.severity).toBe("unknown");
    expect(saude.minutesSinceLastStart).toBeNull();
  });

  it("nao depende da ordem das linhas", () => {
    const runs = diaSaudavel().reverse();
    runs[runs.length - 1] = execucao(30, "failed");

    expect(assessJobHealth(SYNC, runs, AGORA).verdict).toBe("falhou");
  });

  it("aceita Date direto do driver e ignora data invalida", () => {
    const runs: JobRunSnapshot[] = [
      { started_at: "nao-e-data", status: "failed", error_message: null, request_id: "cf-cron-1" },
      ...diaSaudavel().map((run) => ({ ...run, started_at: new Date(run.started_at) })),
    ];

    // Data invalida tratada como "agora" viraria a ultima execucao e o job
    // apareceria falhado sem ter falhado.
    expect(assessJobHealth(SYNC, runs, AGORA).verdict).toBe("ok");
  });
});

describe("assessPipelineHealth", () => {
  function tudoSaudavel(): Map<string, JobRunSnapshot[]> {
    return new Map(
      JOB_EXPECTATIONS.map((esperado) => [
        esperado.name,
        Array.from({ length: esperado.expectedPerDay }, (_, i) =>
          execucao(5 + i * Math.floor((24 * 60) / esperado.expectedPerDay))
        ),
      ])
    );
  }

  it("tudo em dia consolida em ok e sem alerta", () => {
    const saude = assessPipelineHealth(tudoSaudavel(), AGORA);

    expect(saude.severity).toBe("ok");
    expect(saude.problems).toEqual([]);
    expect(pipelineAlertText(saude)).toBeNull();
  });

  it("o pior job decide o tom, e os problemas vem do mais grave para o menos", () => {
    const runs = tudoSaudavel();
    runs.set(JOB_NAMES.workerSync, (runs.get(JOB_NAMES.workerSync) ?? []).slice(0, 5));
    runs.set(JOB_NAMES.shopifyVerify, [execucao(60, "failed", "429")]);

    const saude = assessPipelineHealth(runs, AGORA);

    expect(saude.severity).toBe("crit");
    expect(saude.problems.map((job) => job.name)).toEqual([
      JOB_NAMES.shopifyVerify,
      JOB_NAMES.workerSync,
    ]);
  });

  it("job ausente do mapa entra como sem_registro, nao some", () => {
    const runs = tudoSaudavel();
    runs.delete(JOB_NAMES.materializeOrders);

    const saude = assessPipelineHealth(runs, AGORA);

    expect(saude.jobs).toHaveLength(JOB_EXPECTATIONS.length);
    expect(saude.severity).toBe("unknown");
    expect(saude.problems[0]?.verdict).toBe("sem_registro");
  });

  it("so crit alerta; warn fica no painel", () => {
    const runs = tudoSaudavel();
    runs.set(JOB_NAMES.workerSync, (runs.get(JOB_NAMES.workerSync) ?? []).slice(0, 5));
    expect(pipelineAlertText(assessPipelineHealth(runs, AGORA))).toBeNull();

    runs.set(JOB_NAMES.shopifyVerify, [execucao(60, "failed", "429")]);
    const texto = pipelineAlertText(assessPipelineHealth(runs, AGORA));
    expect(texto).toContain("Verificação contra a Shopify");
    expect(texto).toContain("429");
    expect(texto).not.toContain("Sync OMS");
  });
});

describe("JOB_EXPECTATIONS", () => {
  /**
   * `maxDurationSeconds` e' copia do `export const maxDuration` da rota. Se a
   * rota subir o limite e esta copia nao, toda execucao longa e legitima vira
   * "travado" no painel; se descer, um job morto demora a ser declarado.
   */
  it.each(JOB_EXPECTATIONS.map((esperado) => [esperado.name, esperado.maxDurationSeconds]))(
    "maxDurationSeconds de %s bate com a rota",
    (nome, segundos) => {
      const rota = readFileSync(
        join(process.cwd(), "src/app/api/internal/cron", String(nome), "route.ts"),
        "utf8"
      );
      const declarado = rota.match(/export const maxDuration = (\d+);/)?.[1];
      expect(Number(declarado)).toBe(segundos);
    }
  );
});
