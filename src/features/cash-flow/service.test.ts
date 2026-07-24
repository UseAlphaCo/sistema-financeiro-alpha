import { describe, expect, it } from "vitest";

import { resolveCashFlowDateRange } from "@/features/cash-flow/service";

const NOW = new Date("2026-07-22T15:00:00Z");

describe("resolveCashFlowDateRange", () => {
  it("usa a data como range de 1 dia quando so startDate vem preenchido", () => {
    const { start, end } = resolveCashFlowDateRange({ startDate: "2026-05-22" }, NOW);

    expect(start.getFullYear()).toBe(2026);
    expect(start.getMonth()).toBe(4);
    expect(start.getDate()).toBe(22);
    expect(end.getDate()).toBe(22);
    expect(end.getMonth()).toBe(4);
  });

  it("usa a data como range de 1 dia quando so endDate vem preenchido", () => {
    const { start, end } = resolveCashFlowDateRange({ endDate: "2026-05-22" }, NOW);

    expect(start.getDate()).toBe(22);
    expect(end.getDate()).toBe(22);
  });

  it("nao ignora startDate mesmo com preset default presente (bug do filtro parcial)", () => {
    // Cenario do print: form envia preset="yesterday" (hidden field default)
    // junto com startDate preenchido e endDate vazio — startDate deve vencer.
    const { start, end } = resolveCashFlowDateRange(
      { preset: "yesterday", startDate: "2026-05-22" },
      NOW
    );

    expect(start.getMonth()).toBe(4);
    expect(start.getDate()).toBe(22);
    expect(end.getDate()).toBe(22);
  });

  it("usa startDate e endDate quando ambos vem preenchidos", () => {
    const { start, end } = resolveCashFlowDateRange(
      { startDate: "2026-05-20", endDate: "2026-05-22" },
      NOW
    );

    expect(start.getDate()).toBe(20);
    expect(end.getDate()).toBe(22);
  });

  it("cai no preset apenas quando nenhuma data customizada vem preenchida", () => {
    const { start, end } = resolveCashFlowDateRange({ preset: "yesterday" }, NOW);

    // "Ontem" em relacao a NOW (2026-07-22) e 2026-07-21.
    expect(start.getMonth()).toBe(6);
    expect(start.getDate()).toBe(21);
    expect(end.getDate()).toBe(21);
  });
});
