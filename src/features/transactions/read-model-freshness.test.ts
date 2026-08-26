import { describe, expect, it } from "vitest";

import { resolveFreshness } from "./read-model-freshness";

/**
 * Teto de 25/08/2026 as 11:55 BRT -- o valor real medido em producao no dia em
 * que a flag materializada foi ligada, com o cron rodando 1x/dia as 23 h.
 */
const TETO = "2026-08-25T14:55:00.000Z";

/**
 * "Agora" fixo: 25/08 12:00 BRT, logo depois do teto.
 *
 * Fixo e nao `new Date()` porque a classificacao passou a depender de o periodo
 * ja ter terminado ou nao (`incomplete` x `trailing`). Com relogio real, os
 * mesmos casos mudariam de status conforme a data em que a suite roda -- o
 * teste passaria hoje e falharia amanha sem ninguem mexer no codigo.
 */
const AGORA = new Date("2026-08-25T15:00:00.000Z");

function lag(maxOccurredAt: string | null, maxMaterializedAt = TETO) {
  return { maxOccurredAt, maxMaterializedAt, ordersInWindow: 1_000 };
}

describe("resolveFreshness", () => {
  it("periodo fechado antes do teto nao gera aviso", () => {
    const result = resolveFreshness(
      { startDate: "2026-08-24T03:00:00.000Z", endDate: "2026-08-25T02:59:59.999Z" },
      lag(TETO),
      AGORA
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
      lag(TETO),
      AGORA
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
      lag("2026-08-24T20:00:00.000Z"),
      AGORA
    );

    expect(result.status).toBe("not_yet");
    // Esta e a assercao que importa: sem ela a tela mostra R$ 0,00 e quem olha
    // le "nao vendeu nada".
    expect(result.canShowTotals).toBe(false);
    expect(result.message).toContain("ainda nao foi processado");
  });

  it("dia que ja fechou e ficou incompleto avisa que o numero e parcial", () => {
    // O caso real de 26/08/2026: o preset "Ontem" mostrava 25/08 com 1.365 dos
    // 1.738 pedidos Shopify, porque a materializacao rodou as 23:01 -- ANTES de
    // o dia fechar as 23:59 -- sobre um mirror que ia so ate 20:53. O dia esta
    // fechado e o numero nao esta; trailing seria brando demais aqui.
    const result = resolveFreshness(
      { startDate: "2026-08-25T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag("2026-08-25T23:53:55.000Z", "2026-08-26T02:01:51.000Z"),
      new Date("2026-08-26T14:00:00.000Z")
    );

    expect(result.status).toBe("incomplete");
    // Continua exibindo: o valor e parcial, nao inventado. Suprimir apagaria
    // dado real.
    expect(result.canShowTotals).toBe(true);
    expect(result.message).toContain("ja terminou");
    expect(result.message).toContain("incompletos");
  });

  it("dia fechado e processado depois de fechar nao gera aviso", () => {
    // Estado real do dia 25 depois do reprocessamento das 11:09 BRT de 26/08:
    // 1.735 dos 1.738 pedidos. O teto fica em 23:59:45 porque foi a hora da
    // ULTIMA VENDA, 14 s antes do fim da janela -- exigir que ele alcance o fim
    // pediria uma venda no ultimo segundo de todo dia, e o aviso apareceria
    // sempre. Quem decide e lastRunAt: rodou depois do dia fechar, viu o dia
    // inteiro.
    const result = resolveFreshness(
      { startDate: "2026-08-25T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag("2026-08-26T02:59:45.000Z", "2026-08-26T14:09:28.000Z"),
      new Date("2026-08-26T17:00:00.000Z")
    );

    expect(result.status).toBe("fresh");
    expect(result.message).toBeNull();
  });

  it("periodo em andamento continua trailing, nao incomplete", () => {
    // Mesmo teto do teste anterior, mas consultado ENQUANTO o dia corre:
    // faltar as ultimas horas e o esperado, nao uma anomalia.
    const result = resolveFreshness(
      { startDate: "2026-08-25T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag("2026-08-25T23:53:55.000Z"),
      new Date("2026-08-26T01:00:00.000Z")
    );

    expect(result.status).toBe("trailing");
  });

  it("periodo que atravessa o teto avisa ate onde o dado vai", () => {
    const result = resolveFreshness(
      { startDate: "2026-08-01T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      lag(TETO),
      AGORA
    );

    expect(result.status).toBe("trailing");
    expect(result.canShowTotals).toBe(true);
    expect(result.message).toContain("Dados ate");
  });

  it("fronteira exata conta como coberta", () => {
    // end === teto nao pode virar aviso: o ultimo instante pedido esta
    // materializado.
    const result = resolveFreshness(
      { startDate: "2026-08-01T03:00:00.000Z", endDate: TETO },
      lag(TETO),
      AGORA
    );

    expect(result.status).toBe("fresh");
    expect(result.message).toBeNull();
  });

  it("sem lag avisa que nao sabe, em vez de afirmar frescor", () => {
    const result = resolveFreshness(
      { startDate: "2026-08-01T03:00:00.000Z", endDate: "2026-08-26T02:59:59.999Z" },
      null,
      AGORA
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
      { maxOccurredAt: null, maxMaterializedAt: null, ordersInWindow: 0 },
      AGORA
    );

    expect(result.status).toBe("unknown");
  });

  it("periodo ilegivel nao acusa a materializacao", () => {
    const result = resolveFreshness(
      { startDate: "nao e data", endDate: "tambem nao" },
      lag(TETO),
      AGORA
    );

    expect(result.status).toBe("unknown");
    expect(result.message).toBeNull();
  });
});
