import { describe, expect, it } from "vitest";

import { dedupeMirrorRows } from "@/features/transactions/mirror-order-mapper";
import type { MirrorRow } from "@/features/transactions/read-model-filters";

function row(overrides: Partial<MirrorRow> & { id: string }): MirrorRow {
  return {
    source: "shopify",
    event_type: "orders/create",
    external_order_id: "PEDIDO-1",
    payload_json: { financial_status: "pending", total_price: "100.00" },
    received_at: new Date("2026-08-10T10:00:00Z"),
    mirror_updated_at: null,
    processing_status: "processed",
    resolved_gateway_raw: null,
    resolved_transaction_processed_at: null,
    ...overrides,
  };
}

const pago = { financial_status: "paid", total_price: "100.00" };

describe("dedup de eventos do mirror", () => {
  it("mantem o pago mesmo quando o nao pago e mais recente", () => {
    // Regra que existe por bug real: o worker pode persistir orders/create
    // (pending) depois de orders/paid, pela ordem da fila e nao pela ordem dos
    // eventos na Shopify. Uma vez pago, o pedido continua pago.
    const rows = [
      row({ id: "a", payload_json: pago, received_at: new Date("2026-08-10T10:00:00Z") }),
      row({ id: "b", received_at: new Date("2026-08-10T11:00:00Z") }),
    ];

    expect(dedupeMirrorRows(rows).map((r) => r.id)).toEqual(["a"]);
    expect(dedupeMirrorRows([...rows].reverse()).map((r) => r.id)).toEqual(["a"]);
  });

  it("desempata pela mais recente entre linhas do mesmo status", () => {
    const rows = [
      row({ id: "a", payload_json: pago, received_at: new Date("2026-08-10T10:00:00Z") }),
      row({ id: "b", payload_json: pago, received_at: new Date("2026-08-10T12:00:00Z") }),
    ];

    expect(dedupeMirrorRows(rows).map((r) => r.id)).toEqual(["b"]);
  });

  it("nao depende da ordem de entrada quando a recencia empata", () => {
    // O caso que a carga em bloco produz aos milhares: mesmo instante em todas
    // as linhas. Antes, vencia a primeira em ordem de heap -- resultado
    // diferente entre duas execucoes da mesma consulta.
    const mesmoInstante = new Date("2026-08-10T10:00:00Z");
    const rows = [
      row({ id: "aaa", payload_json: pago, received_at: mesmoInstante, mirror_updated_at: null }),
      row({ id: "bbb", payload_json: pago, received_at: mesmoInstante, mirror_updated_at: null }),
      row({ id: "ccc", payload_json: pago, received_at: mesmoInstante, mirror_updated_at: null }),
    ];

    const direto = dedupeMirrorRows(rows).map((r) => r.id);
    const invertido = dedupeMirrorRows([...rows].reverse()).map((r) => r.id);
    const embaralhado = dedupeMirrorRows([rows[1], rows[2], rows[0]]).map((r) => r.id);

    expect(direto).toEqual(["ccc"]);
    expect(invertido).toEqual(direto);
    expect(embaralhado).toEqual(direto);
  });

  it("prefere mirror_updated_at a received_at na comparacao", () => {
    const rows = [
      row({
        id: "a",
        payload_json: pago,
        received_at: new Date("2026-08-10T10:00:00Z"),
        mirror_updated_at: new Date("2026-08-12T10:00:00Z"),
      }),
      row({
        id: "b",
        payload_json: pago,
        received_at: new Date("2026-08-11T10:00:00Z"),
        mirror_updated_at: new Date("2026-08-11T10:00:00Z"),
      }),
    ];

    expect(dedupeMirrorRows(rows).map((r) => r.id)).toEqual(["a"]);
  });

  it("linha sem data nenhuma perde de qualquer linha datada", () => {
    const rows = [
      row({ id: "a", payload_json: pago, received_at: null, mirror_updated_at: null }),
      row({ id: "b", payload_json: pago, received_at: new Date("2026-08-01T00:00:00Z") }),
    ];

    expect(dedupeMirrorRows(rows).map((r) => r.id)).toEqual(["b"]);
    expect(dedupeMirrorRows([...rows].reverse()).map((r) => r.id)).toEqual(["b"]);
  });

  it("separa pedidos por chave (external_order_id, source)", () => {
    const rows = [
      row({ id: "a", payload_json: pago, external_order_id: "PEDIDO-1" }),
      row({ id: "b", payload_json: pago, external_order_id: "PEDIDO-2" }),
      row({ id: "c", payload_json: pago, external_order_id: "PEDIDO-1", source: "anymarket" }),
    ];

    expect(dedupeMirrorRows(rows)).toHaveLength(3);
  });

  it("usa o proprio id como chave quando nao ha external_order_id", () => {
    const rows = [
      row({ id: "a", payload_json: pago, external_order_id: null }),
      row({ id: "b", payload_json: pago, external_order_id: null }),
    ];

    expect(dedupeMirrorRows(rows)).toHaveLength(2);
  });
});
