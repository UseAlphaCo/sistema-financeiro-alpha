import { getPrismaClient } from "@/core/db/prisma-client";
import type {
  CreateWebhookEventInput,
  WebhookEvent,
  WebhookSource,
  WebhookStatus,
} from "@/features/integration/types";

export type ListWebhookEventsFilters = {
  page?: number;
  limit?: number;
  source?: WebhookSource;
  status?: WebhookStatus;
};

export type PaginatedWebhookEvents = {
  items: WebhookEvent[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    hasNext: boolean;
  };
};

export interface WebhookEventsRepository {
  findByEventId(eventId: string): Promise<WebhookEvent | null>;
  create(input: CreateWebhookEventInput): Promise<WebhookEvent>;
  list(filters: ListWebhookEventsFilters): Promise<PaginatedWebhookEvents>;
}

function mapDbEvent(item: {
  id: string;
  eventId: string;
  source: string;
  topic: string;
  status: string;
  payload: unknown;
  errorMessage: string | null;
  processedAt: Date | null;
  createdAt: Date;
}): WebhookEvent {
  return {
    id: item.id,
    eventId: item.eventId,
    source: item.source as WebhookSource,
    topic: item.topic,
    status: item.status as WebhookStatus,
    payload: item.payload,
    errorMessage: item.errorMessage,
    processedAt: item.processedAt ? item.processedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
  };
}

class PrismaWebhookEventsRepository implements WebhookEventsRepository {
  async findByEventId(eventId: string): Promise<WebhookEvent | null> {
    const db = getPrismaClient();
    const item = await db.webhookEvent.findUnique({ where: { eventId } });
    if (!item) return null;
    return mapDbEvent(item);
  }

  async create(input: CreateWebhookEventInput): Promise<WebhookEvent> {
    const db = getPrismaClient();
    const item = await db.webhookEvent.create({
      data: {
        eventId: input.eventId,
        source: input.source,
        topic: input.topic,
        status: input.status,
        payload: input.payload !== undefined ? (input.payload as object) : undefined,
        errorMessage: input.errorMessage ?? null,
        processedAt: input.processedAt ? new Date(input.processedAt) : null,
      },
    });
    return mapDbEvent(item);
  }

  async list(filters: ListWebhookEventsFilters): Promise<PaginatedWebhookEvents> {
    const db = getPrismaClient();
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const offset = (page - 1) * limit;

    const where = {
      ...(filters.source ? { source: filters.source } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    const [total, items] = await Promise.all([
      db.webhookEvent.count({ where }),
      db.webhookEvent.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: offset,
        take: limit,
      }),
    ]);

    return {
      items: items.map(mapDbEvent),
      pagination: {
        page,
        limit,
        total,
        hasNext: offset + limit < total,
      },
    };
  }
}

export const webhookEventsRepository: WebhookEventsRepository =
  new PrismaWebhookEventsRepository();
