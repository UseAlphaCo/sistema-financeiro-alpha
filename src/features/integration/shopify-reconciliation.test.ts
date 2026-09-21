import { describe, expect, it } from "vitest";

import {
  decideRetryOutcome,
  MAX_RETRY_ATTEMPTS,
  nextAttemptAfter,
} from "./shopify-reconciliation";

/**
 * As duas decisoes da fila de retentativa, isoladas do banco e da Shopify.
 *
 * Sao funcoes puras de proposito: a regra de "quando insistir" e "quando parar
 * de insistir" e' o que separa um sistema auto-regulavel de um que bate na
 * Admin API para sempre, e essa regra nao deveria precisar de um pedido real,
 * de uma conexao e de um mock de rede para ser verificada.
 */

const AGORA = new Date("2026-09-21T13:50:00.000Z");
const UM_DIA_MS = 24 * 60 * 60 * 1000;

function diasDepois(data: Date | null): number | null {
  if (data === null) return null;
  return (data.getTime() - AGORA.getTime()) / UM_DIA_MS;
}

describe("nextAttemptAfter", () => {
  it("dobra a espera a cada tentativa frustrada", () => {
    expect(diasDepois(nextAttemptAfter(1, AGORA))).toBe(1);
    expect(diasDepois(nextAttemptAfter(2, AGORA))).toBe(2);
    expect(diasDepois(nextAttemptAfter(3, AGORA))).toBe(4);
    expect(diasDepois(nextAttemptAfter(4, AGORA))).toBe(8);
  });

  it("devolve null quando o orcamento acaba", () => {
    expect(nextAttemptAfter(MAX_RETRY_ATTEMPTS, AGORA)).toBeNull();
    // Nao e' um off-by-one tolerado: passar do teto tambem nao reagenda.
    expect(nextAttemptAfter(MAX_RETRY_ATTEMPTS + 3, AGORA)).toBeNull();
  });

  it("o teto e' a ultima tentativa, nao a primeira sem espera", () => {
    // Trava a derivacao MAX = esperas + 1. Se alguem acrescentar uma espera sem
    // mexer no teto, ou o contrario, o pedido esgotaria antes de gastar o ultimo
    // intervalo — e ninguem perceberia, porque o sintoma e' so "escalou cedo".
    expect(MAX_RETRY_ATTEMPTS).toBe(5);
    expect(nextAttemptAfter(MAX_RETRY_ATTEMPTS - 1, AGORA)).not.toBeNull();
  });

  it("recusa contagem que nao inclui a tentativa atual", () => {
    // Chamar com 0 seria o erro classico de passar `linha.attempts` cru; o
    // resultado silencioso seria uma espera a menos em toda a escada.
    expect(() => nextAttemptAfter(0, AGORA)).toThrow();
  });
});

describe("decideRetryOutcome", () => {
  it("fecha quando o ledger passou a bater", () => {
    expect(
      decideRetryOutcome({
        aindaDiverge: false,
        attemptsFeitas: 1,
        statusAnterior: "pendente",
        now: AGORA,
      })
    ).toEqual({ status: "corrigido", nextAttemptAt: null });
  });

  it("divergir com orcamento sobrando mantem em pendente, nao em sem_correcao", () => {
    // A mudanca de doutrina desta fase. Antes, uma unica tentativa frustrada ja
    // marcava `sem_correcao`, que o painel pinta de vermelho. Vermelho precisa
    // significar "nenhum mecanismo alcanca isto"; uma linha que a fila vai
    // buscar de novo amanha nao e' isso, e chamar de emergencia o que esta
    // andando e' como um alerta vira ruido.
    const decisao = decideRetryOutcome({
      aindaDiverge: true,
      attemptsFeitas: 1,
      statusAnterior: "pendente",
      now: AGORA,
    });

    expect(decisao.status).toBe("pendente");
    expect(diasDepois(decisao.nextAttemptAt)).toBe(1);
  });

  it("preserva persistente ao longo das retentativas", () => {
    // "Ja fechou e reabriu" e' um sinal sobre a causa, nao sobre a fila.
    // Rebaixar para `pendente` apagaria a unica pista de defeito estrutural.
    const decisao = decideRetryOutcome({
      aindaDiverge: true,
      attemptsFeitas: 2,
      statusAnterior: "persistente",
      now: AGORA,
    });

    expect(decisao.status).toBe("persistente");
    expect(diasDepois(decisao.nextAttemptAt)).toBe(2);
  });

  it("esgotado o orcamento, escala para gente e nao reagenda", () => {
    const decisao = decideRetryOutcome({
      aindaDiverge: true,
      attemptsFeitas: MAX_RETRY_ATTEMPTS,
      statusAnterior: "pendente",
      now: AGORA,
    });

    expect(decisao).toEqual({ status: "sem_correcao", nextAttemptAt: null });
  });

  it("esgotar tambem vale para quem era persistente", () => {
    // Sem isto, o pedido estruturalmente quebrado ficaria `persistente` com
    // `next_attempt_at` nulo — visivel em vermelho, mas indistinguivel de quem
    // ainda tem tentativa no orcamento.
    const decisao = decideRetryOutcome({
      aindaDiverge: true,
      attemptsFeitas: MAX_RETRY_ATTEMPTS,
      statusAnterior: "persistente",
      now: AGORA,
    });

    expect(decisao).toEqual({ status: "sem_correcao", nextAttemptAt: null });
  });

  it("consertar na ultima tentativa fecha como corrigido", () => {
    // A ordem das guardas importa: se o teto fosse checado antes do veredito, o
    // pedido consertado no limite seria arquivado como sem_correcao.
    expect(
      decideRetryOutcome({
        aindaDiverge: false,
        attemptsFeitas: MAX_RETRY_ATTEMPTS,
        statusAnterior: "persistente",
        now: AGORA,
      })
    ).toEqual({ status: "corrigido", nextAttemptAt: null });
  });
});
