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
  total_price: string;
  total_shipping_price?: string;
  total_discounts?: string;
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
