import { describe, expect, it } from "vitest";

import {
  buildContentHash,
  buildSearchText,
  mapMirrorRow,
  normalizeSearchTerm,
  toMaterializedOrder,
} from "@/features/transactions/mirror-order-mapper";
import type { MirrorRow } from "@/features/transactions/read-model-filters";

function shopifyRow(overrides: Partial<MirrorRow> = {}): MirrorRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    source: "shopify",
    event_type: "orders/paid",
    external_order_id: "6543210",
    payload_json: {
      financial_status: "paid",
      name: "#1439377793229",
      total_price: "223.05",
      currency: "BRL",
      processed_at: "2026-08-10T14:00:00-03:00",
      updated_at: "2026-08-11T09:00:00-03:00",
      payment_gateway_names: ["pix"],
    },
    received_at: new Date("2026-08-10T17:05:00Z"),
    mirror_updated_at: new Date("2026-08-10T17:06:00Z"),
    processing_status: "processed",
    resolved_gateway_raw: null,
    resolved_transaction_processed_at: null,
    ...overrides,
  };
}

describe("toMaterializedOrder", () => {
  it("nao divergir de mapMirrorRow nos campos compartilhados", () => {
    // A materializacao DELEGA a mapMirrorRow. Este teste e a trava contra
    // alguem reimplementar o mapeamento aqui no futuro: se os dois caminhos
    // discordarem, o sintoma na producao seria numero diferente entre a tela e
    // a tabela, sem erro nenhum.
    const row = shopifyRow();
    const transaction = mapMirrorRow(row);
    const order = toMaterializedOrder(row);

    expect(transaction).not.toBeNull();
    expect(order).not.toBeNull();
    expect(order?.amountCents).toBe(transaction?.amountCents);
    expect(order?.liquidCents).toBe(transaction?.liquidCents);
    expect(order?.occurredAt).toBe(transaction?.occurredAt);
    expect(order?.paymentMethodNormalized).toBe(transaction?.paymentMethodNormalized);
    expect(order?.status).toBe(transaction?.status);
    expect(order?.txSource).toBe(transaction?.source);
    expect(order?.description).toBe(transaction?.description);
  });

  it("deriva order_key de external_order_id e mirror_row_id do evento", () => {
    const order = toMaterializedOrder(shopifyRow());

    expect(order?.orderKey).toBe("6543210");
    expect(order?.externalId).toBe("6543210");
    expect(order?.mirrorRowId).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("cai no id quando nao ha external_order_id", () => {
    // order_key = COALESCE(external_order_id, id::text): a mesma expressao do
    // dedup. external_id fica null, e e essa diferenca que a UI precisa ver.
    const order = toMaterializedOrder(shopifyRow({ external_order_id: null }));

    expect(order?.orderKey).toBe("11111111-1111-1111-1111-111111111111");
    expect(order?.externalId).toBeNull();
  });

  it("usa marketplace ?? externalSource ?? source no bucket de origem", () => {
    // NAO o COALESCE(NULLIF(marketplace,''), source) do SQL legado, que ignora
    // externalSource e agrupa pedido de marketplace sob a origem tecnica.
    const shopify = toMaterializedOrder(shopifyRow());
    expect(shopify?.marketplace).toBe("Shopify");
    expect(shopify?.sourceBucket).toBe("Shopify");
    expect(shopify?.marketplaceKey).toBe("shopify");
    expect(shopify?.sourceKey).toBe("shopify");

    const anymarket = toMaterializedOrder({
      ...shopifyRow(),
      source: "anymarket",
      event_type: null,
      payload_json: {
        paymentStatus: "PAID",
        marketPlace: "MERCADO_LIVRE",
        marketPlaceNumber: "2000018003764190",
        total: 66.51,
        paymentDate: "2026-08-10T14:00:00-03:00",
      },
    });

    expect(anymarket?.marketplace).toBe("Mercado Livre");
    expect(anymarket?.sourceBucket).toBe("Mercado Livre");
    expect(anymarket?.marketplaceKey).toBe("mercado_livre");
    expect(anymarket?.sourceKey).toBe("anymarket");
  });

  it("tira source_updated_at do payload, nao do mirror", () => {
    // mirror_updated_at e metadado de infraestrutura: mudaria a cada recarga do
    // mirror e nao diz nada sobre o pedido.
    const order = toMaterializedOrder(shopifyRow());

    expect(order?.sourceUpdatedAt).toBe("2026-08-11T12:00:00.000Z");
    expect(order?.receivedAt).toBe("2026-08-10T17:05:00.000Z");
  });

  it("devolve null nos mesmos casos que mapMirrorRow", () => {
    // E esse null que o job usa para APAGAR a chave -- sem isso, pedido
    // estornado soma para sempre.
    const naoPago = shopifyRow({ event_type: "orders/create", payload_json: { financial_status: "pending", total_price: "10.00" } });
    expect(toMaterializedOrder(naoPago)).toBeNull();
    expect(mapMirrorRow(naoPago)).toBeNull();

    const semValor = shopifyRow({ payload_json: { financial_status: "paid", total_price: "0.00", processed_at: "2026-08-10T14:00:00-03:00" } });
    expect(toMaterializedOrder(semValor)).toBeNull();
    expect(mapMirrorRow(semValor)).toBeNull();
  });
});

describe("busca textual", () => {
  it("reproduz o haystack de filterTransactions", () => {
    // Paridade byte a byte: mesmos quatro campos, mesma ordem, filter(Boolean),
    // unidos por espaco, minusculo. Divergir aqui faz a busca da tela e a da
    // tabela materializada devolverem conjuntos diferentes, em silencio.
    const item = {
      description: "Pedido #1439",
      externalId: "6543210",
      orderNumber: "#1439",
      marketplace: "Shopify",
    };

    const esperado = [item.description, item.externalId, item.orderNumber, item.marketplace]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    expect(buildSearchText(item)).toBe(esperado);
  });

  it("ignora campos ausentes e devolve null quando nao sobra nada", () => {
    expect(buildSearchText({ description: null, externalId: "6543210", orderNumber: null, marketplace: null })).toBe("6543210");
    expect(buildSearchText({ description: null, externalId: null, orderNumber: null, marketplace: null })).toBeNull();
  });

  it("normaliza o termo do mesmo jeito que normaliza o indice", () => {
    expect(normalizeSearchTerm("  #1439 ")).toBe("#1439");
    expect(normalizeSearchTerm("PIX")).toBe("pix");
  });
});

describe("content_hash", () => {
  const base = toMaterializedOrder(shopifyRow());

  it("e estavel para o mesmo conteudo", () => {
    expect(toMaterializedOrder(shopifyRow())?.contentHash).toBe(base?.contentHash);
  });

  it("muda quando um valor de negocio muda", () => {
    const outro = toMaterializedOrder(
      shopifyRow({ payload_json: { ...(shopifyRow().payload_json as object), total_price: "999.00" } })
    );

    expect(outro?.contentHash).not.toBe(base?.contentHash);
  });

  it("NAO muda quando so received_at/mirror_updated_at mudam", () => {
    // A propriedade central: a recarga do mirror da Fase A reescreve essas duas
    // colunas em centenas de milhares de linhas. Se elas entrassem no hash,
    // toda a tabela materializada seria invalidada de uma vez -- o oposto do
    // que o guard de no-op existe para fazer.
    const recarregado = toMaterializedOrder(
      shopifyRow({
        received_at: new Date("2026-08-22T03:00:00Z"),
        mirror_updated_at: new Date("2026-08-22T03:00:00Z"),
      })
    );

    expect(recarregado?.contentHash).toBe(base?.contentHash);
    expect(recarregado?.receivedAt).not.toBe(base?.receivedAt);
  });

  it("separa campos por 0x1f para nao confundir concatenacoes", () => {
    if (!base) throw new Error("base nula");

    // Com separador comum, mover um caractere de fronteira entre dois campos
    // daria o mesmo hash e o guard veria "sem mudanca".
    const a = buildContentHash({ ...base, orderNumber: "AB", description: "C" });
    const b = buildContentHash({ ...base, orderNumber: "A", description: "BC" });

    expect(a).not.toBe(b);
  });
});
