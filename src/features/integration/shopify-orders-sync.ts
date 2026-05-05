import { getPrismaClient } from "@/core/db/prisma-client";
import { logError, logInfo } from "@/core/observability/logger";
import type { ActionResult } from "@/types/api";

import type { ShopifyOrderPayload } from "./types";

type SyncResult = {
  fetched: number;
  imported: number;
  skipped: number;
  failed: number;
};

type ShopifyOrdersResponse = {
  orders: ShopifyOrderPayload[];
};

function mapOrderToPrismaData(order: ShopifyOrderPayload) {
  const rawPrice = parseFloat(order.total_price);
  const amountCents = Math.round((isNaN(rawPrice) ? 0 : rawPrice) * 100);
  return {
    externalSource: "shopify" as const,
    externalId: String(order.id),
    type: "income" as const,
    source: "integration" as const,
    status: "approved" as const,
    amountCents,
    currency: order.currency ?? "BRL",
    occurredAt: new Date(order.processed_at ?? order.created_at),
    description: `Pedido #${order.order_number}`,
  };
}

export async function syncShopifyOrders(
  storeUrl: string,
  accessToken: string,
  days = 30
): Promise<ActionResult<SyncResult>> {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();

  let allOrders: ShopifyOrderPayload[] = [];

  // Busca pedidos paginados (250 por página, limite da API REST)
  let pageUrl: string | null =
    `https://${storeUrl}/admin/api/2024-10/orders.json` +
    `?status=any&limit=250&created_at_min=${sinceIso}&financial_status=paid`;

  while (pageUrl) {
    let res: Response;
    try {
      res = await fetch(pageUrl, {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      return {
        success: false,
        error: `Falha ao conectar na API Shopify: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        success: false,
        error: `API Shopify retornou ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    const json = (await res.json()) as ShopifyOrdersResponse;
    allOrders = allOrders.concat(json.orders ?? []);

    // Paginação via Link header
    const linkHeader = res.headers.get("Link") ?? "";
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    pageUrl = nextMatch ? nextMatch[1] : null;
  }

  logInfo("shopify_sync_fetched", { fetched: allOrders.length, days });

  const db = getPrismaClient();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const order of allOrders) {
    const externalId = String(order.id);
    try {
      // Upsert idempotente — não duplica pedidos já existentes
      const result = await db.financialTransaction.upsert({
        where: {
          externalSource_externalId: {
            externalSource: "shopify",
            externalId,
          },
        },
        update: {},
        create: mapOrderToPrismaData(order),
      });

      // Se o updatedAt === createdAt, foi criado agora (não existia antes)
      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        imported++;
      } else {
        skipped++;
      }
    } catch (err) {
      failed++;
      logError("shopify_sync_order_failed", {
        externalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logInfo("shopify_sync_complete", { fetched: allOrders.length, imported, skipped, failed });

  return {
    success: true,
    data: {
      fetched: allOrders.length,
      imported,
      skipped,
      failed,
    },
  };
}
