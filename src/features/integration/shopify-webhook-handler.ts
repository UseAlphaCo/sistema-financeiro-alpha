import { getPrismaClient } from "@/core/db/prisma-client";
import type { CreateTransactionInput } from "@/features/transactions/types";
import type { ActionResult } from "@/types/api";

import { resolveShopifyPaymentMethod } from "./payment-method";
import type { ShopifyOrderPayload, WebhookStatus } from "./types";
import { webhookEventsRepository } from "./webhook-events-repository";

const SUPPORTED_TOPICS = ["orders/paid", "orders/create"] as const;

function parseMoneyToCents(value: string | undefined | null): number {
  const parsed = parseFloat(value ?? "0");
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

function isShopifyOrderPayload(value: unknown): value is ShopifyOrderPayload {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    ("id" in p) &&
    ("total_price" in p) &&
    ("currency" in p) &&
    (("processed_at" in p) || ("created_at" in p))
  );
}

function normalizeShopifyDisplayOrderNumber(order: ShopifyOrderPayload): string {
  const fromName = typeof order.name === "string" ? order.name.trim() : "";
  if (fromName) {
    return fromName.startsWith("#") ? fromName : `#${fromName}`;
  }

  const fromOrderNumber = String(order.order_number ?? "").trim();
  if (fromOrderNumber) {
    const clean = fromOrderNumber.replace(/^#/, "");
    return `#${clean}`;
  }

  return `#${String(order.id)}`;
}

function mapOrderToTransaction(
  order: ShopifyOrderPayload
): CreateTransactionInput {
  const amountCents = parseMoneyToCents(order.total_price);
  const shippingCents = parseMoneyToCents(order.total_shipping_price);
  const discountCents = parseMoneyToCents(order.total_discounts);
  const taxCents = parseMoneyToCents(order.total_tax);
  const feeCents = parseMoneyToCents(order.current_total_additional_fees_set?.shop_money?.amount);
  const paymentMethod = resolveShopifyPaymentMethod(order);
  const displayOrderNumber = normalizeShopifyDisplayOrderNumber(order);

  return {
    externalSource: "shopify",
    externalId: String(order.id),
    marketplace: "shopify",
    orderNumber: displayOrderNumber,
    paymentMethodRaw: paymentMethod.raw ?? undefined,
    paymentMethodNormalized: paymentMethod.normalized,
    shippingCents,
    discountCents,
    taxCents,
    feeCents,
    type: "income",
    source: "webhook",
    status: "approved",
    amountCents,
    currency: order.currency ?? "BRL",
    occurredAt: order.processed_at ?? order.created_at,
    description: `Pedido ${displayOrderNumber}`,
  };
}

export async function handleShopifyWebhook(
  eventId: string,
  topic: string,
  rawPayload: unknown
): Promise<ActionResult<{ status: WebhookStatus }>> {
  const existing = await webhookEventsRepository.findByEventId(eventId);
  if (existing) {
    return { success: true, data: { status: "skipped" } };
  }

  const isSupportedTopic = (SUPPORTED_TOPICS as readonly string[]).includes(topic);
  if (!isSupportedTopic) {
    await webhookEventsRepository.create({
      eventId,
      source: "shopify",
      topic,
      status: "skipped",
      payload: rawPayload,
      processedAt: new Date().toISOString(),
    });
    return { success: true, data: { status: "skipped" } };
  }

  if (!isShopifyOrderPayload(rawPayload)) {
    await webhookEventsRepository.create({
      eventId,
      source: "shopify",
      topic,
      status: "failed",
      payload: rawPayload,
      errorMessage: "Payload inválido ou incompleto",
      processedAt: new Date().toISOString(),
    });
    return {
      success: false,
      error: "Payload do pedido Shopify inválido",
    };
  }

  const transactionInput = mapOrderToTransaction(rawPayload);

  try {
    const db = getPrismaClient();

    await db.$transaction(async (tx) => {
      await tx.financialTransaction.upsert({
        where: {
          externalSource_externalId: {
            externalSource: "shopify",
            externalId: transactionInput.externalId!,
          },
        },
        update: {
          marketplace: transactionInput.marketplace ?? null,
          orderNumber: transactionInput.orderNumber ?? null,
          paymentMethodRaw: transactionInput.paymentMethodRaw ?? null,
          paymentMethodNormalized: transactionInput.paymentMethodNormalized ?? null,
          shippingCents: transactionInput.shippingCents ?? 0,
          discountCents: transactionInput.discountCents ?? 0,
          taxCents: transactionInput.taxCents ?? 0,
          feeCents: transactionInput.feeCents ?? 0,
          status: transactionInput.status ?? "pending",
          amountCents: transactionInput.amountCents,
          currency: transactionInput.currency ?? "BRL",
          occurredAt: new Date(transactionInput.occurredAt),
          description: transactionInput.description ?? null,
        },
        create: {
          externalSource: transactionInput.externalSource!,
          externalId: transactionInput.externalId!,
          marketplace: transactionInput.marketplace ?? null,
          orderNumber: transactionInput.orderNumber ?? null,
          paymentMethodRaw: transactionInput.paymentMethodRaw ?? null,
          paymentMethodNormalized: transactionInput.paymentMethodNormalized ?? null,
          shippingCents: transactionInput.shippingCents ?? 0,
          discountCents: transactionInput.discountCents ?? 0,
          taxCents: transactionInput.taxCents ?? 0,
          feeCents: transactionInput.feeCents ?? 0,
          type: transactionInput.type,
          source: transactionInput.source,
          status: transactionInput.status ?? "pending",
          amountCents: transactionInput.amountCents,
          currency: transactionInput.currency ?? "BRL",
          occurredAt: new Date(transactionInput.occurredAt),
          description: transactionInput.description ?? null,
        },
      });

      await tx.webhookEvent.create({
        data: {
          eventId,
          source: "shopify",
          topic,
          status: "processed",
          payload: rawPayload as object,
          processedAt: new Date(),
        },
      });
    });

    return { success: true, data: { status: "processed" } };
  } catch (err) {
    await webhookEventsRepository.create({
      eventId,
      source: "shopify",
      topic,
      status: "failed",
      payload: rawPayload,
      errorMessage: err instanceof Error ? err.message : "Erro desconhecido",
      processedAt: new Date().toISOString(),
    });

    return {
      success: false,
      error: err instanceof Error ? err.message : "Falha ao processar webhook",
    };
  }
}
