import { describe, expect, it } from "vitest";

import { resolveCashFlowDateRange } from "@/features/cash-flow/service";

const NOW = new Date("2026-07-22T15:00:00Z");

/**
 * As asseveracoes sao sobre o INSTANTE (toISOString), nunca sobre getDate() /
 * getMonth().
 *
 * Os getters locais resolvem no fuso do processo, entao passavam tanto com o
 * codigo certo quanto com o errado -- davam confianca sem provar nada. E o
 * defeito que estes testes existem para pegar so aparece quando o fuso do
 * processo muda: em UTC (a Vercel) o dia 22/05 virava
 * 2026-05-22T00:00:00Z, tres horas antes do inicio real do dia em Brasilia.
 *
 * 03:00Z = 00:00-03 e 02:59:59.999Z do dia seguinte = 23:59:59.999-03.
 */
describe("resolveCashFlowDateRange", () => {
  it("usa a data como range de 1 dia quando so startDate vem preenchido", () => {
    const { start, end } = resolveCashFlowDateRange({ startDate: "2026-05-22" }, NOW);

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("usa a data como range de 1 dia quando so endDate vem preenchido", () => {
    const { start, end } = resolveCashFlowDateRange({ endDate: "2026-05-22" }, NOW);

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("nao ignora startDate mesmo com preset default presente (bug do filtro parcial)", () => {
    // Cenario do print: form envia preset="yesterday" (hidden field default)
    // junto com startDate preenchido e endDate vazio — startDate deve vencer.
    const { start, end } = resolveCashFlowDateRange(
      { preset: "yesterday", startDate: "2026-05-22" },
      NOW
    );

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("usa startDate e endDate quando ambos vem preenchidos", () => {
    const { start, end } = resolveCashFlowDateRange(
      { startDate: "2026-05-20", endDate: "2026-05-22" },
      NOW
    );

    expect(start.toISOString()).toBe("2026-05-20T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });

  it("cai no preset apenas quando nenhuma data customizada vem preenchida", () => {
    const { start, end } = resolveCashFlowDateRange({ preset: "yesterday" }, NOW);

    // "Ontem" em relacao a NOW (22/07 12:00 em Brasilia) e 21/07.
    expect(start.toISOString()).toBe("2026-07-21T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-22T02:59:59.999Z");
  });

  it("resolve o dia de Brasilia, e nao o dia UTC, perto da virada", () => {
    // 2026-07-23T01:00:00Z ainda e 22/07 22:00 em Brasilia. O dia UTC ja virou;
    // o dia do negocio, nao. "Ontem" tem que ser 21/07, nao 22/07.
    const quaseMeiaNoiteUtc = new Date("2026-07-23T01:00:00Z");
    const { start, end } = resolveCashFlowDateRange({ preset: "yesterday" }, quaseMeiaNoiteUtc);

    expect(start.toISOString()).toBe("2026-07-21T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-07-22T02:59:59.999Z");
  });

  it("aceita ISO completo alem de YYYY-MM-DD", () => {
    // O schema de actions.ts permite as duas formas. A implementacao antiga
    // lancava para ISO completo: Number("22T00:00:00.000Z") = NaN.
    const { start, end } = resolveCashFlowDateRange(
      { startDate: "2026-05-22T10:00:00.000Z", endDate: "2026-05-22T10:00:00.000Z" },
      NOW
    );

    expect(start.toISOString()).toBe("2026-05-22T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-05-23T02:59:59.999Z");
  });
});
