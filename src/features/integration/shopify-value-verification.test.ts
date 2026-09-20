import { describe, expect, it } from "vitest";

import { detectOrderDivergences } from "./shopify-value-verification";

/**
 * Testes da regra de deteccao por pedido.
 *
 * O que estes casos protegem nao e' aritmetica — e a exclusao de credito na loja.
 * Ela foi medida duas vezes (30/08 e 07/09/2026) e, sem ela, ~18 pedidos por dia
 * viram divergencia permanente que ninguem consegue fechar. Como agora existe um
 * conserto automatico ligado a esta lista, uma regressao aqui deixaria de ser um
 * painel barulhento e passaria a reescrever o ledger de pedidos corretos.
 */

/** Atalho: o ledger por pedido tem o formato Map<orderId, Map<gateway, cents>>. */
function ledger(entries: Record<string, Record<string, number>>): Map<string, Map<string, number>> {
  return new Map(
    Object.entries(entries).map(([orderId, gateways]) => [orderId, new Map(Object.entries(gateways))])
  );
}

describe("detectOrderDivergences", () => {
  it("nao acusa nada quando o tender e o ledger fecham", () => {
    const divergences = detectOrderDivergences(
      new Map([["7551826624737", 19992]]),
      ledger({ "7551826624737": { pix: 19992 } }),
      1
    );

    expect(divergences).toEqual([]);
  });

  it("ignora diferenca dentro da tolerancia", () => {
    const divergences = detectOrderDivergences(
      new Map([["1", 10001]]),
      ledger({ "1": { pix: 10000 } }),
      1
    );

    expect(divergences).toEqual([]);
  });

  it("descarta a perna de credito na loja antes de comparar", () => {
    // Caso real de 07/09/2026: o tender reporta so a perna Pix, e o ledger tem
    // Pix + credito. Somar o credito faria um pedido correto divergir.
    const divergences = detectOrderDivergences(
      new Map([["7553206321377", 1831]]),
      ledger({ "7553206321377": { pix: 1831, shopify_store_credit: 18400 } }),
      1
    );

    expect(divergences).toEqual([]);
  });

  it("acusa captura que a Shopify registrou e o ledger nao tem", () => {
    // A classe que a reconciliacao existe para fechar: o pedido ja foi resolvido,
    // e a captura Appmax chegou depois, sem tocar o payload do mirror.
    const divergences = detectOrderDivergences(
      new Map([["7530846552289", 191742]]),
      ledger({ "7530846552289": { "appmax-cartao": 182242 } }),
      1
    );

    expect(divergences).toEqual([
      { orderId: "7530846552289", tenderCents: 191742, ledgerCents: 182242, deltaCents: 9500 },
    ]);
  });

  it("trata pedido ausente do ledger como desvio integral", () => {
    const divergences = detectOrderDivergences(new Map([["999", 5000]]), ledger({}), 1);

    expect(divergences).toEqual([
      { orderId: "999", tenderCents: 5000, ledgerCents: 0, deltaCents: 5000 },
    ]);
  });

  it("acusa desvio negativo, quando o ledger tem mais que o tender", () => {
    const divergences = detectOrderDivergences(
      new Map([["1", 1000]]),
      ledger({ "1": { pix: 2500 } }),
      1
    );

    expect(divergences[0]).toMatchObject({ orderId: "1", deltaCents: -1500 });
  });

  it("ordena por |delta| decrescente, para o teto de correcoes pegar o maior dinheiro", () => {
    const divergences = detectOrderDivergences(
      new Map([
        ["pequeno", 1100],
        ["grande", 50000],
        ["negativo-medio", 100],
      ]),
      ledger({
        pequeno: { pix: 1000 },
        grande: { pix: 10000 },
        "negativo-medio": { pix: 5100 },
      }),
      1
    );

    expect(divergences.map((item) => item.orderId)).toEqual(["grande", "negativo-medio", "pequeno"]);
  });

  it("nao acusa pedido que so existe no ledger (ponto cego do tender)", () => {
    // Pedido pago 100% com credito na loja: a Shopify nao emite tender para ele.
    // Ausencia de informacao, nunca ausencia de dinheiro.
    const divergences = detectOrderDivergences(
      new Map(),
      ledger({ "7551826624737": { shopify_store_credit: 19992 } }),
      1
    );

    expect(divergences).toEqual([]);
  });
});
