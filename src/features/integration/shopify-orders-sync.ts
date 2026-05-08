import { getPrismaClient } from "@/core/db/prisma-client";
import { logError, logInfo } from "@/core/observability/logger";
import type { ActionResult } from "@/types/api";

import { mapShopifyOrderFinancials } from "./shopify-order-mapper";
import type { ShopifyOrderPayload } from "./types";

type SyncResult = {
  fetched: number;
  imported: number;
  skipped: number;
  failed: number;
  failureReasons: Record<string, number>;
};

type ShopifyOrdersResponse = {
  orders: ShopifyOrderPayload[];
};

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^['"]+|['"]+$/g, "").replace(/\r?\n/g, "").trim();
}

function normalizeShopifyStoreDomain(storeUrl: string): string {
  const input = stripWrappingQuotes(storeUrl);
  if (!input) return "";

  try {
    const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    return url.hostname;
  } catch {
    return input.replace(/^https?:\/\//i, "").replace(/\/.*/, "");
  }
}

function formatFetchError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }

  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeObj = cause as { code?: string; message?: string };
    const parts = [err.message];
    if (causeObj.code) {
      parts.push(`code=${causeObj.code}`);
    }
    if (causeObj.message) {
      parts.push(`cause=${causeObj.message}`);
    }
    return parts.join(" | ");
  }

  return err.message;
}

function extractFailureReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out/i.test(message)) return "timeout";
  if (/date|invalid.*occurredAt/i.test(message)) return "invalid_date";
  if (/connection|database|socket|prisma/i.test(message)) return "database_error";
  if (/unique|constraint/i.test(message)) return "constraint_error";
  return "unknown_error";
}

function mapOrderToPrismaData(order: ShopifyOrderPayload) {
  const mapped = mapShopifyOrderFinancials(order);
  return {
    externalSource: "shopify" as const,
    externalId: mapped.externalId,
    marketplace: "shopify",
    orderNumber: mapped.orderNumber,
    paymentMethodRaw: mapped.paymentMethodRaw,
    paymentMethodNormalized: mapped.paymentMethodNormalized,
    shippingCents: mapped.shippingCents,
    discountCents: mapped.discountCents,
    taxCents: mapped.taxCents,
    feeCents: mapped.feeCents,
    type: "income" as const,
    source: "integration" as const,
    status: "approved" as const,
    amountCents: mapped.amountCents,
    currency: mapped.currency,
    occurredAt: mapped.occurredAt,
    description: mapped.description,
  };
}

export async function syncShopifyOrders(
  storeUrl: string,
  accessToken: string,
  days = 30
): Promise<ActionResult<SyncResult>> {
  const storeDomain = normalizeShopifyStoreDomain(storeUrl);
  const safeToken = stripWrappingQuotes(accessToken);

  logInfo("shopify_sync_started", {
    storeDomain,
    tokenLength: safeToken.length,
    days,
  });

  if (!storeDomain) {
    return {
      success: false,
      error: "SHOPIFY_STORE_URL invalida.",
    };
  }

  if (!safeToken) {
    return {
      success: false,
      error: "SHOPIFY_ACCESS_TOKEN invalido ou vazio.",
    };
  }

  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceIso = since.toISOString();

  let allOrders: ShopifyOrderPayload[] = [];

  // Busca pedidos paginados (250 por página, limite da API REST)
  let pageUrl: string | null =
    `https://${storeDomain}/admin/api/2024-10/orders.json` +
    `?status=any&limit=250&created_at_min=${sinceIso}&financial_status=paid`;

  while (pageUrl) {
    let res: Response;
    try {
      res = await fetch(pageUrl, {
        headers: {
          "X-Shopify-Access-Token": safeToken,
          "Content-Type": "application/json",
        },
      });
    } catch (err) {
      logError("shopify_sync_fetch_failed", {
        storeDomain,
        pageUrl,
        error: formatFetchError(err),
      });
      return {
        success: false,
        error: `Falha ao conectar na API Shopify: ${formatFetchError(err)}`,
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
  const failureReasons: Record<string, number> = {};

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
        update: mapOrderToPrismaData(order),
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
      const reason = extractFailureReason(err);
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
      logError("shopify_sync_order_failed", {
        externalId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logInfo("shopify_sync_complete", {
    fetched: allOrders.length,
    imported,
    skipped,
    failed,
    failureReasons,
  });

  return {
    success: true,
    data: {
      fetched: allOrders.length,
      imported,
      skipped,
      failed,
      failureReasons,
    },
  };
}
