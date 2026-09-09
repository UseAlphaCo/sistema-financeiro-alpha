import { describe, expect, it } from "vitest";

import {
  tenderOrderIdsInWindow,
  tenderTotalsByOrder,
  widenedWindowForDay,
  type TenderTransaction,
} from "./shopify-tender-transactions";

const TIMEZONE = "America/Bahia";

type TenderSpec = {
  orderId: string;
  /** ISO, para o teste dizer o instante sem cerimonia. */
  processedAt: string;
  amountCents?: number;
  test?: boolean;
};

function tender(spec: TenderSpec): TenderTransaction {
  return {
    orderId: spec.orderId,
    processedAt: new Date(spec.processedAt),
    amountCents: spec.amountCents ?? 10_000,
    test: spec.test ?? false,
  };
}

// 08/09/2026 em America/Bahia (UTC-3): [03:00Z do dia 08, 03:00Z do dia 09).
const START = new Date("2026-09-08T03:00:00.000Z");
const END = new Date("2026-09-09T03:00:00.000Z");

describe("widenedWindowForDay", () => {
  it("alarga um dia para cada lado, em instantes do fuso local", () => {
    const { from, to } = widenedWindowForDay("2026-09-08", TIMEZONE);

    expect(from.toISOString()).toBe("2026-09-07T03:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-10T03:00:00.000Z");
  });

  it("cobre com folga a janela real do dia", () => {
    const { from, to } = widenedWindowForDay("2026-09-08", TIMEZONE);

    expect(from.getTime()).toBeLessThan(START.getTime());
    expect(to.getTime()).toBeGreaterThan(END.getTime());
  });
});

describe("tenderOrderIdsInWindow", () => {
  it("inclui o inicio e exclui o fim da janela", () => {
    const ids = tenderOrderIdsInWindow(
      [
        tender({ orderId: "no-limite-inicial", processedAt: "2026-09-08T03:00:00.000Z" }),
        tender({ orderId: "no-limite-final", processedAt: "2026-09-09T03:00:00.000Z" }),
      ],
      START,
      END
    );

    expect([...ids]).toEqual(["no-limite-inicial"]);
  });

  it("descarta pagamento de teste", () => {
    const ids = tenderOrderIdsInWindow(
      [
        tender({ orderId: "real", processedAt: "2026-09-08T12:00:00.000Z" }),
        tender({ orderId: "teste", processedAt: "2026-09-08T12:00:00.000Z", test: true }),
      ],
      START,
      END
    );

    expect([...ids]).toEqual(["real"]);
  });

  it("nao perde as ultimas 3 h do dia local", () => {
    // O bug que motivou a extracao: com o literal de data lido em UTC, a janela
    // parava a meia-noite UTC e este pagamento — 21:30 no horario da loja —
    // ficava de fora todo dia.
    const ids = tenderOrderIdsInWindow(
      [tender({ orderId: "fim-do-dia", processedAt: "2026-09-09T00:30:00.000Z" })],
      START,
      END
    );

    expect(ids.has("fim-do-dia")).toBe(true);
  });
});

describe("tenderTotalsByOrder", () => {
  it("soma as pernas do mesmo pedido, inclusive fora da janela do dia", () => {
    // Captura Appmax que cai de madrugada: as duas pernas pertencem ao mesmo
    // pedido, e comparar o pedido pelo total exige enxergar as duas.
    const { byOrder } = tenderTotalsByOrder([
      tender({ orderId: "7551", processedAt: "2026-09-08T20:00:00.000Z", amountCents: 5_000 }),
      tender({ orderId: "7551", processedAt: "2026-09-09T05:00:00.000Z", amountCents: 3_000 }),
    ]);

    expect(byOrder.get("7551")).toBe(8_000);
  });

  it("restringe ao conjunto de pedidos quando informado", () => {
    const { byOrder } = tenderTotalsByOrder(
      [
        tender({ orderId: "dentro", processedAt: "2026-09-08T20:00:00.000Z", amountCents: 1_000 }),
        tender({ orderId: "fora", processedAt: "2026-09-08T20:00:00.000Z", amountCents: 9_000 }),
      ],
      new Set(["dentro"])
    );

    expect([...byOrder.keys()]).toEqual(["dentro"]);
    expect(byOrder.get("dentro")).toBe(1_000);
  });

  it("descarta entrada negativa e a contabiliza", () => {
    // O ledger so soma sale/capture/change e ignora refund. Somar a tender
    // negativa aqui faria todo pedido reembolsado divergir para sempre contra
    // um ledger que nunca vai concordar.
    const { byOrder, negativeEntries } = tenderTotalsByOrder([
      tender({ orderId: "reembolsado", processedAt: "2026-09-08T20:00:00.000Z", amountCents: 10_000 }),
      tender({ orderId: "reembolsado", processedAt: "2026-09-08T21:00:00.000Z", amountCents: -10_000 }),
    ]);

    expect(byOrder.get("reembolsado")).toBe(10_000);
    expect(negativeEntries).toBe(1);
  });

  it("nao conta pagamento de teste", () => {
    const { byOrder } = tenderTotalsByOrder([
      tender({ orderId: "teste", processedAt: "2026-09-08T20:00:00.000Z", test: true }),
    ]);

    expect(byOrder.size).toBe(0);
  });
});
