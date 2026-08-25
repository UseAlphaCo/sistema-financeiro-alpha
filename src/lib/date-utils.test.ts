import { describe, expect, it } from "vitest";

import {
  addDaysToDayKey,
  dayWindowUtc,
  endOfZonedDay,
  getDateRangeForPeriod,
  getDateRangeForPreset,
  getPreviousPeriodRange,
  normalizeToEndOfDay,
  normalizeToStartOfDay,
  startOfZonedDay,
  zonedDayKey,
} from "@/lib/date-utils";

/**
 * Tudo aqui e afirmado por instante absoluto (toISOString), nunca por getters
 * locais: o defeito que estas funcoes corrigem so se manifesta quando o fuso do
 * processo muda, entao um teste que le a data no fuso do processo nao o veria.
 *
 * 03:00Z = 00:00-03. 02:59:59.999Z do dia seguinte = 23:59:59.999-03.
 */
describe("fronteiras de dia em Brasilia", () => {
  it("recorta o dia de calendario a partir de um instante no meio do dia", () => {
    const instante = new Date("2026-08-24T18:30:00Z");

    expect(normalizeToStartOfDay(instante).toISOString()).toBe("2026-08-24T03:00:00.000Z");
    expect(normalizeToEndOfDay(instante).toISOString()).toBe("2026-08-25T02:59:59.999Z");
  });

  it("usa o dia de Brasilia quando o dia UTC ja virou", () => {
    // 25/08 01:00Z e 24/08 22:00 em Brasilia: o dia do negocio ainda e 24.
    const depoisDaViradaUtc = new Date("2026-08-25T01:00:00Z");

    expect(zonedDayKey(depoisDaViradaUtc)).toBe("2026-08-24");
    expect(normalizeToStartOfDay(depoisDaViradaUtc).toISOString()).toBe(
      "2026-08-24T03:00:00.000Z"
    );
  });

  it("usa o dia de Brasilia quando o dia UTC ainda nao virou", () => {
    // 24/08 02:00Z e 23/08 23:00 em Brasilia.
    const antesDaViradaUtc = new Date("2026-08-24T02:00:00Z");

    expect(zonedDayKey(antesDaViradaUtc)).toBe("2026-08-23");
  });

  it("fecha o dia 1 ms antes do inicio do dia seguinte", () => {
    const fim = endOfZonedDay("2026-08-24");
    const inicioSeguinte = startOfZonedDay("2026-08-25");

    expect(inicioSeguinte.getTime() - fim.getTime()).toBe(1);
  });

  it("caminha em dias de calendario sem passar por fuso", () => {
    expect(addDaysToDayKey("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysToDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysToDayKey("2026-08-24", 0)).toBe("2026-08-24");
  });

  it("devolve janela semiaberta em dayWindowUtc", () => {
    const { start, end } = dayWindowUtc("2026-08-24", "America/Sao_Paulo");

    expect(start.toISOString()).toBe("2026-08-24T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-25T03:00:00.000Z");
  });
});

describe("intervalos de periodo", () => {
  const agora = new Date("2026-08-25T15:00:00Z"); // 25/08 12:00 em Brasilia

  it("monta o periodo de N dias terminando hoje", () => {
    const { start, end } = getDateRangeForPeriod(7, agora);

    expect(start.toISOString()).toBe("2026-08-19T03:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-26T02:59:59.999Z");
  });

  it("resolve os presets today e yesterday pelo dia de Brasilia", () => {
    const hoje = getDateRangeForPreset("today", agora);
    const ontem = getDateRangeForPreset("yesterday", agora);

    expect(hoje.start.toISOString()).toBe("2026-08-25T03:00:00.000Z");
    expect(hoje.end.toISOString()).toBe("2026-08-26T02:59:59.999Z");
    expect(ontem.start.toISOString()).toBe("2026-08-24T03:00:00.000Z");
    expect(ontem.end.toISOString()).toBe("2026-08-25T02:59:59.999Z");
  });

  it("encaixa o periodo anterior imediatamente antes do atual, sem buraco nem sobreposicao", () => {
    const atual = getDateRangeForPeriod(7, agora);
    const anterior = getPreviousPeriodRange(atual.start, 7);

    expect(anterior.start.toISOString()).toBe("2026-08-12T03:00:00.000Z");
    expect(anterior.end.toISOString()).toBe("2026-08-19T02:59:59.999Z");
    expect(atual.start.getTime() - anterior.end.getTime()).toBe(1);
  });
});
