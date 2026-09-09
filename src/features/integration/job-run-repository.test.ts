// O vitest nao carrega .env por conta propria: sem isto, `conn` fica undefined
// e o teste toma o caminho de skip em silencio.
import "dotenv/config";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeJobRunPool,
  ensureJobRunsTable,
  listJobRunsByName,
  listLatestJobRuns,
  withJobRun,
  type JobRunRow,
} from "./job-run-repository";

const conn = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

/**
 * Nome FIXO e inexistente na producao, pelo mesmo motivo das chaves fixas em
 * financial-orders-repository.test.ts: uma execucao morta antes do `finally`
 * (timeout do vitest, Ctrl-C) deixa residuo, e com nome fixo a limpeza do
 * inicio remove o residuo de qualquer execucao anterior. Com nome aleatorio o
 * lixo ficaria na tabela para sempre, e apareceria no painel de /integracoes
 * como um job de verdade que ninguem reconhece.
 */
const TEST_JOB = "vitest-job-run";

describe("job-run-repository (integration)", () => {
  if (!conn) {
    it("pula quando nao ha CORE_DB_URL nem DATABASE_URL", () => {
      expect(true).toBe(true);
    });
    return;
  }

  const pool = new Pool({ connectionString: conn, max: 1 });

  async function limpar() {
    await pool.query(`DELETE FROM integration.job_runs WHERE job_name = $1`, [TEST_JOB]);
  }

  beforeAll(async () => {
    await ensureJobRunsTable();
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
    await closeJobRunPool();
  });

  it("registra execucao bem-sucedida com o resumo devolvido", async () => {
    const devolvido = await withJobRun(TEST_JOB, { days: "2026-09-07" }, "req-ok", async () => ({
      written: 0,
      candidateKeys: 12,
    }));

    // O valor de fn chega intacto a quem chamou: o registro nao pode alterar o
    // contrato da rota.
    expect(devolvido).toEqual({ written: 0, candidateKeys: 12 });

    const [linha] = await listJobRunsByName(TEST_JOB);
    expect(linha.status).toBe("ok");
    expect(linha.finished_at).not.toBeNull();
    expect(linha.error_message).toBeNull();
    expect(linha.request_id).toBe("req-ok");
    expect(linha.params).toEqual({ days: "2026-09-07" });

    // O ponto central desta tabela: uma passagem que nao mudou nada precisa
    // deixar vestigio. E' o unico sinal que distingue "rodou e nada mudou" de
    // "nao rodou" -- max(materialized_at) nao distingue, por causa do guard de
    // content_hash no UPSERT, e foi o que levou ao diagnostico errado em
    // 08/09/2026.
    expect((linha.result as { written: number }).written).toBe(0);
    expect(linha.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("registra falha e re-lanca a excecao", async () => {
    await expect(
      withJobRun(TEST_JOB, { days: "2026-09-06" }, "req-erro", async () => {
        throw new Error("estourou no meio");
      })
    ).rejects.toThrow("estourou no meio");

    const linhas = await listJobRunsByName(TEST_JOB);
    const falha = linhas.find((l: JobRunRow) => l.request_id === "req-erro");

    // Sem isto o job que quebra some sem deixar rastro -- exatamente o caso que
    // o painel precisa mostrar em vermelho.
    expect(falha).toBeDefined();
    expect(falha?.status).toBe("failed");
    expect(falha?.error_message).toBe("estourou no meio");
    expect(falha?.finished_at).not.toBeNull();
  });

  it("listLatestJobRuns devolve uma linha por job, a mais recente", async () => {
    const todas = await listLatestJobRuns();
    const doTeste = todas.filter((l: JobRunRow) => l.job_name === TEST_JOB);

    expect(doTeste).toHaveLength(1);
    // As duas execucoes acima rodaram nesta ordem; a mais recente e' a que falhou.
    expect(doTeste[0].request_id).toBe("req-erro");
  });
});
