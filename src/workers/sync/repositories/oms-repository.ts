import type { Pool } from "pg";

import { getNextRetryAt } from "../retry-policy";
import type { SyncEventRow } from "../types";

type RawPayloadCandidate = {
  id: string;
  source: string | null;
  externalOrderId: string | null;
  eventType: string | null;
  payloadJson: unknown;
  headersJson: unknown;
  receivedAt: Date | null;
  processedAt: Date | null;
  processingStatus: string | null;
  errorMessage: string | null;
};

export class OmsRepository {
  constructor(private readonly pool: Pool) {}

  async findRawPayloadCandidates(days: 30 | 60 | 90, limit: number): Promise<RawPayloadCandidate[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 5000);

    const result = await this.pool.query<{
      id: string;
      source: string | null;
      external_order_id: string | null;
      event_type: string | null;
      payload_json: unknown;
      headers_json: unknown;
      received_at: Date | null;
      processed_at: Date | null;
      processing_status: string | null;
      error_message: string | null;
    }>(
      `
        SELECT
          rp.id,
          rp.source,
          rp.external_order_id,
          rp.event_type,
          rp.payload_json,
          rp.headers_json,
          rp.received_at,
          rp.processed_at,
          rp.processing_status,
          rp.error_message
        FROM raw_payloads rp
        WHERE COALESCE(rp.received_at, rp.processed_at, NOW()) >= NOW() - ($1 * INTERVAL '1 day')
        ORDER BY COALESCE(rp.received_at, rp.processed_at, NOW()) DESC
        LIMIT $2
      `,
      [days, boundedLimit]
    );

    return result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      externalOrderId: row.external_order_id,
      eventType: row.event_type,
      payloadJson: row.payload_json,
      headersJson: row.headers_json,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      processingStatus: row.processing_status,
      errorMessage: row.error_message,
    }));
  }

  async enqueueRawPayloadBackfill(candidates: RawPayloadCandidate[]): Promise<number> {
    let inserted = 0;

    for (const item of candidates) {
      const payload = {
        id: item.id,
        source: item.source,
        external_order_id: item.externalOrderId,
        event_type: item.eventType,
        payload_json: item.payloadJson,
        headers_json: item.headersJson,
        received_at: item.receivedAt,
        processed_at: item.processedAt,
        processing_status: item.processingStatus,
        error_message: item.errorMessage,
      };

      const result = await this.pool.query(
        `
          INSERT INTO integration.sync_events (
            table_name,
            record_id,
            operation,
            payload,
            processed,
            retries,
            created_at,
            next_retry_at
          )
          SELECT
            'raw_payloads',
            $1,
            'INSERT',
            $2::jsonb,
            FALSE,
            0,
            NOW(),
            NULL
          WHERE NOT EXISTS (
            SELECT 1
            FROM integration.sync_events se
            WHERE se.table_name = 'raw_payloads'
              AND se.record_id = $1
              AND se.processed = FALSE
          )
        `,
        [item.id, JSON.stringify(payload)]
      );

      inserted += result.rowCount ?? 0;
    }

    return inserted;
  }

  async ensureInfrastructure(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

    await this.pool.query(`
      ALTER TABLE integration.sync_events
      ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS integration.failed_jobs (
        id BIGSERIAL PRIMARY KEY,
        sync_event_id BIGINT NOT NULL,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload JSONB,
        retries INTEGER NOT NULL,
        error_message TEXT,
        moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async acquireExecutionLock(lockKey: number): Promise<boolean> {
    const result = await this.pool.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [lockKey]
    );

    return Boolean(result.rows[0]?.locked);
  }

  async releaseExecutionLock(lockKey: number): Promise<void> {
    await this.pool.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
  }

  async findPendingEvents(batchSize: number, maxRetries: number): Promise<SyncEventRow[]> {
    const result = await this.pool.query<{
      id: number;
      table_name: string;
      record_id: string;
      operation: string;
      payload: unknown;
      retries: number;
      next_retry_at: Date | null;
    }>(
      `
        SELECT id, table_name, record_id, operation, payload, retries, next_retry_at
        FROM integration.sync_events
        WHERE processed = FALSE
          AND retries < $1
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY retries DESC, id ASC
        LIMIT $2
      `,
      [maxRetries, batchSize]
    );

    return result.rows.map((row) => ({
      id: row.id,
      tableName: row.table_name,
      recordId: row.record_id,
      operation: row.operation as SyncEventRow["operation"],
      payload: row.payload,
      retries: row.retries,
      nextRetryAt: row.next_retry_at,
    }));
  }

  async markProcessed(eventId: number): Promise<void> {
    await this.pool.query(
      `
        UPDATE integration.sync_events
        SET processed = TRUE,
            processed_at = NOW(),
            error_message = NULL,
            next_retry_at = NULL
        WHERE id = $1
      `,
      [eventId]
    );
  }

  async markFailed(event: SyncEventRow, errorMessage: string): Promise<number> {
    const nextAttempt = event.retries + 1;
    const nextRetryAt = getNextRetryAt(nextAttempt);

    const result = await this.pool.query<{ retries: number }>(
      `
        UPDATE integration.sync_events
        SET retries = retries + 1,
            error_message = LEFT($2, 1500),
            next_retry_at = $3
        WHERE id = $1
        RETURNING retries
      `,
      [event.id, errorMessage, nextRetryAt.toISOString()]
    );

    return result.rows[0]?.retries ?? nextAttempt;
  }

  async moveToDeadLetter(event: SyncEventRow, retries: number, errorMessage: string): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO integration.failed_jobs (
          sync_event_id,
          table_name,
          record_id,
          operation,
          payload,
          retries,
          error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, LEFT($7, 1500))
      `,
      [event.id, event.tableName, event.recordId, event.operation, event.payload ?? null, retries, errorMessage]
    );

    await this.pool.query(
      `
        UPDATE integration.sync_events
        SET processed = TRUE,
            processed_at = NOW(),
            next_retry_at = NULL
        WHERE id = $1
      `,
      [event.id]
    );
  }
}

export type { RawPayloadCandidate };
