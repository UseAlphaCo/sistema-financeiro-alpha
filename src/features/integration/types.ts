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
  currency: string;
  processed_at: string;
  created_at: string;
};
