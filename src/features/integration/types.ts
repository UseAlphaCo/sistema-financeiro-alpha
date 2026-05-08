export const WEBHOOK_SOURCES = ["shopify"] as const;
export const WEBHOOK_STATUSES = ["processed", "failed", "skipped"] as const;

export type WebhookSource = (typeof WEBHOOK_SOURCES)[number];
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];

export type WebhookEvent = {
  id: string;
  eventId: string;
  source: WebhookSource;
  topic: string;
  status: WebhookStatus;
  payload: unknown;
  errorMessage: string | null;
  processedAt: string | null;
  createdAt: string;
};

export type CreateWebhookEventInput = {
  eventId: string;
  source: WebhookSource;
  topic: string;
  status: WebhookStatus;
  payload?: unknown;
  errorMessage?: string;
  processedAt?: string;
};

export type ShopifyOrderPayload = {
  id: string | number;
  order_number: string | number;
  name?: string; // Número completo do pedido, ex: #1439377643455
  total_price: string;
  total_shipping_price?: string;
  total_shipping_price_set?: {
    shop_money?: { amount?: string };
    presentment_money?: { amount?: string };
  } | null;
  current_total_shipping_price_set?: {
    shop_money?: { amount?: string };
    presentment_money?: { amount?: string };
  } | null;
  total_discounts?: string;
  current_total_discounts?: string;
  current_total_discounts_set?: {
    shop_money?: { amount?: string };
    presentment_money?: { amount?: string };
  } | null;
  total_tax?: string;
  current_total_additional_fees_set?: {
    shop_money?: { amount?: string };
    presentment_money?: { amount?: string };
  } | null;
  currency: string;
  processed_at: string;
  created_at: string;
  gateway?: string | null;
  payment_gateway_names?: string[] | null;
  note?: string | null;
  note_attributes?: Array<{
    name?: string;
    value?: string;
  }> | null;
  shipping_lines?: Array<{
    price?: string;
    discounted_price?: string;
    price_set?: {
      shop_money?: { amount?: string };
      presentment_money?: { amount?: string };
    };
    discounted_price_set?: {
      shop_money?: { amount?: string };
      presentment_money?: { amount?: string };
    };
  }> | null;
  line_items?: Array<{
    total_discount?: string;
    total_discount_set?: {
      shop_money?: { amount?: string };
      presentment_money?: { amount?: string };
    };
  }> | null;
  transactions?: Array<{
    id?: string | number;
    type?: string;
    status?: string;
    gateway?: string;
    payment_details?: {
      credit_card?: {
        brand?: string;
      };
      wallet?: {
        type?: string;
      };
    };
  }> | null;
};
