import type { Pool } from "pg";

import type { RawPayloadRecord } from "../types";

export class CoreRepository {
  constructor(private readonly pool: Pool) {}

  async findExistingRawPayloadIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) {
      return new Set<string>();
    }

    const result = await this.pool.query<{ id: string }>(
      `
        SELECT id
        FROM mirror.raw_payloads
        WHERE id = ANY($1::uuid[])
      `,
      [ids]
    );

    return new Set(result.rows.map((row) => row.id));
  }

  async upsertRawPayload(data: RawPayloadRecord): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO mirror.raw_payloads (
          id,
          source,
          external_order_id,
          event_type,
          payload_json,
          headers_json,
          received_at,
          processed_at,
          processing_status,
          error_message,
          synced_at,
          mirror_updated_at
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          NOW(),
          NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          source = EXCLUDED.source,
          external_order_id = EXCLUDED.external_order_id,
          event_type = EXCLUDED.event_type,
          payload_json = EXCLUDED.payload_json,
          headers_json = EXCLUDED.headers_json,
          received_at = EXCLUDED.received_at,
          processed_at = EXCLUDED.processed_at,
          processing_status = EXCLUDED.processing_status,
          error_message = EXCLUDED.error_message,
          synced_at = NOW(),
          mirror_updated_at = NOW()
      `,
      [
        data.id,
        data.source,
        data.externalOrderId,
        data.eventType,
        data.payloadJson,
        data.headersJson,
        data.receivedAt,
        data.processedAt,
        data.processingStatus,
        data.errorMessage,
      ]
    );
  }

  async deleteRawPayloadById(id: string): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM mirror.raw_payloads
        WHERE id = $1
      `,
      [id]
    );
  }
}
