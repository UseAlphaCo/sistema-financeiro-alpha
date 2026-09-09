import { describe, expect, it } from "vitest";

import {
  buildVerificationView,
  LEDGER_VS_SHOPIFY_METRIC_LABEL,
  type VerificationRunInput,
} from "./verification-run-view";

/**
 * O que estes testes protegem: o painel nunca pode apresentar como fechado um
 * numero que ainda esta se movendo, e nunca pode quebrar por causa do formato
 * do jsonb que leu do banco.
 */

function run(overrides: Partial<VerificationRunInput> = {}): VerificationRunInput {
  return {
    started_at: "2026-09-09T12:31:00.000Z",
    status: "ok",
    error_message: null,
    result: null,
    ...overrides,
  };
}

function relatorio(options: {
  isMature: boolean;
  unresolvedOrders?: number;
  ordersWithoutLedger?: number;
  materializedAfterWindow?: boolean;
  divergentOrders?: number;
  driftFormatted?: string;
  metrics?: Array<{ label: string; diff: string; diffPct: string; diverges: boolean }>;
}) {
  return {
    report: {
      date: "2026-09-08",
      metrics: options.metrics ?? [],
      maturity: {
        isMature: options.isMature,
        unresolvedOrders: options.unresolvedOrders ?? 0,
        ordersWithoutLedger: options.ordersWithoutLedger ?? 0,
        materializedAfterWindow: options.materializedAfterWindow ?? true,
        lastMaterializedAt: "2026-09-09T09:31:09.776Z",
      },
      ledgerVsShopify: {
        comparedOrders: 801,
        divergentOrders: options.divergentOrders ?? 0,
        driftCents: 0,
        driftFormatted: options.driftFormatted ?? "R$ 0,00",
        storeCreditBlindSpotCents: 758421,
        storeCreditBlindSpotFormatted: "R$ 7.584,21",
        ordersOnlyInLedger: 19,
        tenderNegativeEntries: 2,
      },
    },
    alert: "none",
  };
}

describe("buildVerificationView: ausencia e formato", () => {
  it("sem linha nenhuma nao e o mesmo que conferido", () => {
    const view = buildVerificationView(null);

    expect(view.status).toBe("sem_registro");
    expect(view.ledgerVsShopify).toBeNull();
    // O zero tranquilizador e' exatamente o que este painel existe para evitar.
    expect(view.metricasDivergentes).toEqual([]);
  });

  it("execucao que falhou preserva o erro e nao inventa relatorio", () => {
    const view = buildVerificationView(
      run({ status: "failed", error_message: "timeout ao ler o ledger", result: null })
    );

    expect(view.status).toBe("falhou");
    expect(view.errorMessage).toBe("timeout ao ler o ledger");
    expect(view.ledgerVsShopify).toBeNull();
  });

  it("linha da versao antiga vira formato_desconhecido em vez de quebrar a tela", () => {
    // A v1 gravava outra forma. Uma linha dessas pode sobreviver 90 dias na
    // tabela, e o painel e' a tela que o admin abre quando algo quebrou.
    const view = buildVerificationView(run({ result: { ok: true, divergencias: 3 } }));

    expect(view.status).toBe("formato_desconhecido");
  });

  it("nao lanca com result de tipo inesperado", () => {
    for (const result of [42, "texto", [], true, null]) {
      expect(() => buildVerificationView(run({ result }))).not.toThrow();
    }
  });
});

describe("buildVerificationView: maturidade qualifica o numero", () => {
  it("dia imaturo e provisorio mesmo com desvio grande", () => {
    // Medicao real de 09/09/2026 as 08:46 BRT sobre o dia 08/09: R$ 10.293,27
    // em 60 pedidos, com 56 ainda sem perna no ledger. As 09:31, sem ninguem
    // corrigir nada, o mesmo dia leu R$ 679,69 em 3 pedidos.
    const view = buildVerificationView(
      run({
        result: relatorio({
          isMature: false,
          unresolvedOrders: 65,
          ordersWithoutLedger: 56,
          divergentOrders: 60,
          driftFormatted: "R$ 10.293,27",
          metrics: [
            { label: "Faturamento bruto", diff: "-R$ 1.152,79", diffPct: "-0.77%", diverges: true },
          ],
        }),
      })
    );

    expect(view.status).toBe("provisoria");
    expect(view.ledgerVsShopify?.driftFormatted).toBe("R$ 10.293,27");
    expect(view.pendencias).toEqual([
      "65 pedido(s) ainda sem gateway resolvido",
      "56 pedido(s) materializados sem rateio",
    ]);
  });

  it("nomeia a materializacao quando ela nao passou depois de o dia fechar", () => {
    const view = buildVerificationView(
      run({ result: relatorio({ isMature: false, materializedAfterWindow: false }) })
    );

    expect(view.pendencias).toEqual(["a materialização não passou depois de o dia fechar"]);
  });

  it("dia maduro sem divergencia e conferido, sem pendencia", () => {
    const view = buildVerificationView(run({ result: relatorio({ isMature: true }) }));

    expect(view.status).toBe("conferido");
    expect(view.pendencias).toEqual([]);
  });

  it("dia maduro com divergencia e divergente, e lista so o que diverge", () => {
    const view = buildVerificationView(
      run({
        result: relatorio({
          isMature: true,
          divergentOrders: 3,
          driftFormatted: "R$ 679,69",
          metrics: [
            { label: "Faturamento bruto", diff: "-R$ 1.152,79", diffPct: "-0.77%", diverges: true },
            { label: "Faturamento — other", diff: "R$ 0,00", diffPct: "0.00%", diverges: false },
          ],
        }),
      })
    );

    expect(view.status).toBe("divergente");
    expect(view.metricasDivergentes).toEqual([
      { label: "Faturamento bruto", diff: "-R$ 1.152,79", diffPct: "-0.77%" },
    ]);
    expect(view.ledgerVsShopify?.divergentOrders).toBe(3);
  });

  it("respeita isMature do relatorio, e nao recalcula a partir das pendencias", () => {
    // Se o painel derivasse maturidade por conta propria, passaria a existir uma
    // segunda definicao capaz de discordar da que decidiu (ou nao) disparar o
    // alerta na execucao. Aqui os contadores estao zerados e isMature e falso:
    // quem manda e' o relatorio.
    const view = buildVerificationView(run({ result: relatorio({ isMature: false }) }));

    expect(view.status).toBe("provisoria");
  });

  it("sem bloco de maturidade trata como provisorio, nunca como fechado", () => {
    const view = buildVerificationView(
      run({ result: { report: { date: "2026-09-08", metrics: [] } } })
    );

    expect(view.status).toBe("provisoria");
    expect(view.pendencias).toEqual(["a execução não registrou sinais de maturidade"]);
  });
});

describe("buildVerificationView: a ponta 2 nao sai duas vezes", () => {
  it("descarta a metrica Ledger x Shopify, que ja tem bloco proprio", () => {
    // Ela esta em `metrics` para o CLI e o log terem tudo num lugar so. No
    // painel o mesmo desvio ja aparece como bloco; repetir na lista de "Sistema
    // x ledger" mostraria dois problemas do tamanho de um, e o segundo sob o
    // titulo da ponta errada.
    const view = buildVerificationView(
      run({
        result: relatorio({
          isMature: true,
          divergentOrders: 3,
          driftFormatted: "R$ 679,69",
          metrics: [
            {
              label: LEDGER_VS_SHOPIFY_METRIC_LABEL,
              diff: "R$ 679,69",
              diffPct: "3 pedido(s)",
              diverges: true,
            },
            { label: "Faturamento bruto", diff: "-R$ 1.152,79", diffPct: "-0.77%", diverges: true },
          ],
        }),
      })
    );

    expect(view.metricasDivergentes.map((m) => m.label)).toEqual(["Faturamento bruto"]);
    // Mas continua visivel pelo bloco proprio — descartar da lista nao pode
    // significar sumir com o numero.
    expect(view.ledgerVsShopify?.driftFormatted).toBe("R$ 679,69");
  });

  it("o dia continua divergente quando SO a ponta 2 diverge", () => {
    // O descarte e' de exibicao, nao de veredito: se o unico problema for a
    // deriva contra a Shopify, o card ainda precisa acender.
    const view = buildVerificationView(
      run({
        result: relatorio({
          isMature: true,
          divergentOrders: 3,
          driftFormatted: "R$ 679,69",
          metrics: [
            {
              label: LEDGER_VS_SHOPIFY_METRIC_LABEL,
              diff: "R$ 679,69",
              diffPct: "3 pedido(s)",
              diverges: true,
            },
          ],
        }),
      })
    );

    expect(view.status).toBe("divergente");
    expect(view.metricasDivergentes).toEqual([]);
  });
});

describe("buildVerificationView: ponto cego declarado", () => {
  it("credito na loja aparece como contexto, nao como divergencia", () => {
    const view = buildVerificationView(run({ result: relatorio({ isMature: true }) }));

    expect(view.ledgerVsShopify?.blindSpotFormatted).toBe("R$ 7.584,21");
    expect(view.ledgerVsShopify?.ordersOnlyInLedger).toBe(19);
    // Ponto cego nao entra no desvio: a Shopify nao emite tender para credito na
    // loja, entao contar isso como divergencia criaria um alarme que ninguem
    // consegue fechar nunca.
    expect(view.ledgerVsShopify?.divergentOrders).toBe(0);
    expect(view.status).toBe("conferido");
  });
});
