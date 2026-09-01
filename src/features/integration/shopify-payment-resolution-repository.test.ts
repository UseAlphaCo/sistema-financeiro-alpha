// O vitest nao carrega .env por conta propria: sem isto, `conn` fica undefined
// e o teste toma o caminho de skip em silencio (mesma armadilha documentada em
// financial-orders-repository.test.ts).
import "dotenv/config";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  closeShopifyPaymentResolutionPool,
  ensureShopifyPaymentGatewaySplitTable,
  replaceShopifyPaymentGatewaySplit,
} from "./shopify-payment-resolution-repository";

const conn = process.env.CORE_DB_URL ?? process.env.DATABASE_URL;

/**
 * Id que nao pode colidir com pedido real: os da Shopify sao numericos.
 *
 * A data das linhas fica em 2020 de proposito. Se uma execucao morrer antes do
 * `finally`, o residuo nao cai em nenhuma janela que as telas consultem — o
 * piso do read model e 01/08/2026. Chave fixa (nao aleatoria) para que a
 * limpeza de entrada apague o residuo de qualquer execucao anterior.
 */
const TEST_ORDER_ID = "vitest-gateway-split";
const TEST_PROCESSED_AT = "2020-01-01T12:00:00.000Z";

async function lerRateio(): Promise<Array<{ gateway: string; amount: number; count: number }>> {
  const pool = new Pool({ connectionString: conn, max: 1 });
  try {
    const result = await pool.query<{ gateway_raw: string; amount_cents: string; transaction_count: number }>(
      `SELECT gateway_raw, amount_cents, transaction_count
       FROM integration.shopify_order_payment_gateway_split
       WHERE external_order_id = $1
       ORDER BY gateway_raw`,
      [TEST_ORDER_ID]
    );
    return result.rows.map((row) => ({
      gateway: row.gateway_raw,
      amount: Number(row.amount_cents),
      count: Number(row.transaction_count),
    }));
  } finally {
    await pool.end();
  }
}

describe("shopify-payment-resolution-repository (integration)", () => {
  if (!conn) {
    it("pula quando nao ha CORE_DB_URL nem DATABASE_URL", () => {
      expect(true).toBe(true);
    });
    return;
  }

  it("substitui o rateio, removendo gateway que saiu do conjunto", { timeout: 30_000 }, async () => {
    await ensureShopifyPaymentGatewaySplitTable();
    await replaceShopifyPaymentGatewaySplit(TEST_ORDER_ID, []);

    try {
      await replaceShopifyPaymentGatewaySplit(TEST_ORDER_ID, [
        { gatewayRaw: "Pix (3% de desconto)", amountCents: 6_000, transactionCount: 1, processedAt: TEST_PROCESSED_AT },
        { gatewayRaw: "shopify_store_credit", amountCents: 4_000, transactionCount: 2, processedAt: TEST_PROCESSED_AT },
      ]);

      expect(await lerRateio()).toEqual([
        { gateway: "Pix (3% de desconto)", amount: 6_000, count: 1 },
        { gateway: "shopify_store_credit", amount: 4_000, count: 2 },
      ]);

      // O ponto do DELETE dentro do CTE: uma nova resolucao em que o credito na
      // loja sumiu tem de APAGAR aquela linha. So com ON CONFLICT ela ficaria
      // para sempre, e o gateway apareceria em dobro na soma da janela.
      await replaceShopifyPaymentGatewaySplit(TEST_ORDER_ID, [
        {
          gatewayRaw: "Pix (3% de desconto)",
          amountCents: 10_000,
          transactionCount: 3,
          processedAt: TEST_PROCESSED_AT,
        },
      ]);

      expect(await lerRateio()).toEqual([{ gateway: "Pix (3% de desconto)", amount: 10_000, count: 3 }]);

      // Lista vazia limpa tudo (pedido que deixou de ter transacao resolvivel).
      await replaceShopifyPaymentGatewaySplit(TEST_ORDER_ID, []);
      expect(await lerRateio()).toEqual([]);
    } finally {
      await replaceShopifyPaymentGatewaySplit(TEST_ORDER_ID, []);
      await closeShopifyPaymentResolutionPool();
    }
  });
});
