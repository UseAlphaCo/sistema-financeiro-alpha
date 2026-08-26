import { describe, expect, it } from "vitest";

import { resolveFreshness } from "./read-model-freshness";

/**
 * Teto de 25/08/2026 as 11:55 BRT -- o valor real medido em producao no dia em
 * que a flag materializada foi ligada, com o cron rodando 1x/dia as 23 h.
 */
const TETO = "2026-08-25T14:55:00.000Z";

function lag(maxOccurredAt: string | null, maxMaterializedAt = TETO) {
  return { maxOccurredAt, maxMaterializedAt, ordersInWindow: 1_000 };
}

describe("resolveFreshness", () => {
  it("periodo fechado antes do teto nao gera aviso", () => {
    const result = resolveFreshness(
      { startDate: "2026-08-24T03:00:00.000Z", endDate: "2026-08-25T02:59:59.999Z" },
      lag(TETO)
    );

    expect(result.status).toBe("fresh");
    expect(result.message).toBeNull();
    expect(result.canShowTotals).toBe(true);
  });

  it("preset Hoje antes da materializacao nao pode exibir totais", () => {
    // O caso que motiva o modulo: 25/08 00:00 BRT em diante, com teto as 11:55.
    // O periodo COMECA antes do teto, entao isto e trailing -- ver o teste
    // seguinte para o not_yet de verdade.
    const result = resolveFreshness(
      { startDate: "2026-08-25T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag(TETO)
    );

    expect(result.status).toBe("trailing");
    expect(result.canShowTotals).toBe(true);
    expect(result.message).toContain("25/08");
  });

  it("periodo inteiro depois do teto suprime os totais", () => {
    // Teto congelado em 24/08 (cron nao rodou) e usuario pedindo o dia 25:
    // nao ha uma linha sequer, e os agregados voltariam todos zero.
    const result = resolveFreshness(
      { startDate: "2026-08-25T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag("2026-08-24T20:00:00.000Z")
    );

    expect(result.status).toBe("not_yet");
    // Esta e a assercao que importa: sem ela a tela mostra R$ 0,00 e quem olha
    // le "nao vendeu nada".
    expect(result.canShowTotals).toBe(false);
    expect(result.message).toContain("ainda nao foi processado");
  });

  it("periodo que atravessa o teto avisa ate onde o dado vai", () => {
    const result = resolveFreshness(
      { startDate: "2026-08-01T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag(TETO)
    );

    expect(result.status).toBe("trailing");
    expect(result.canShowTotals).toBe(true);
    expect(result.message).toContain("Dados ate");
  });

  it("fronteira exata conta como coberta", () => {
    // end === teto nao pode virar aviso: o ultimo instante pedido esta
    // materializado.
    const result = resolveFreshness({ startDate: "2026-08-01T03:00:00.000Z", endDate: TETO }, lag(TETO));

    expect(result.status).toBe("fresh");
    expect(result.message).toBeNull();
  });

  it("sem lag avisa que nao sabe, em vez de afirmar frescor", () => {
    const result = resolveFreshness(
      { startDate: "2026-08-01T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      null
    );

    expect(result.status).toBe("unknown");
    expect(result.message).toContain("parada");
    // Nao suprime os totais: o que quer que as telas tenham conseguido ler
    // continua sendo o melhor dado disponivel.
    expect(result.canShowTotals).toBe(true);
  });

  it("janela de frescor vazia cai em unknown", () => {
    // ordersInWindow zero com maxOccurredAt null e materializacao parada ha mais
    // de uma semana -- o unico estado em que a tela fica vazia sem explicacao.
    const result = resolveFreshness(
      { startDate: "2026-08-01T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      { maxOccurredAt: null, maxMaterializedAt: null, ordersInWindow: 0 }
    );

    expect(result.status).toBe("unknown");
  });

  it("periodo ilegivel nao acusa a materializacao", () => {
    const result = resolveFreshness({ startDate: "nao e data", endDate: "tambem nao" }, lag(TETO));

    expect(result.status).toBe("unknown");
    expect(result.message).toBeNull();
  });
});
