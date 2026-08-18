import type { Pool } from "pg";

import { getNextRetryAt } from "../retry-policy";
import type {
  RawPayloadCandidate,
  RawPayloadRecord,
  SyncControlStore,
  SyncEventRow,
  SyncWatermark,
} from "../types";

export class CoreRepository implements SyncControlStore {
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

  /**
   * Cria/garante as estruturas tecnicas de sincronizacao no CORE de forma
   * idempotente. Segue o mesmo padrao de ensureJobsTable (worker_sync_jobs).
   */
  async ensureInfrastructure(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS integration`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS integration.sync_queue (
        id BIGSERIAL PRIMARY KEY,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload JSONB,
        retries INTEGER NOT NULL DEFAULT 0,
        next_retry_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_table_record
        ON integration.sync_queue(table_name, record_id)
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry_at
        ON integration.sync_queue(next_retry_at)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS integration.failed_jobs (
        id BIGSERIAL PRIMARY KEY,
        sync_event_id BIGINT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload JSONB,
        retries INTEGER NOT NULL,
        error_message TEXT,
        moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_failed_jobs_moved_at
        ON integration.failed_jobs(moved_at)
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS integration.sync_watermark (
        stream TEXT PRIMARY KEY,
        sort_at TIMESTAMPTZ,
        record_id TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  /**
   * Marca d'agua da descoberta incremental. Vive no CORE, como todo o controle
   * tecnico de sync — o OMS opera read-only e nao aceita escrita nenhuma
   * (ver createOmsPool e OmsRepository).
   */
  async getWatermark(stream: string): Promise<SyncWatermark | null> {
    const result = await this.pool.query<{ sort_at: Date | null; record_id: string | null }>(
      `
        SELECT sort_at, record_id
        FROM integration.sync_watermark
        WHERE stream = $1
      `,
      [stream]
    );

    const row = result.rows[0];
    if (!row?.sort_at) return null;

    return { sortAt: row.sort_at, recordId: row.record_id ?? "" };
  }

  async setWatermark(stream: string, watermark: SyncWatermark): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO integration.sync_watermark (stream, sort_at, record_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (stream) DO UPDATE
          SET sort_at = EXCLUDED.sort_at,
              record_id = EXCLUDED.record_id,
              updated_at = NOW()
      `,
      [stream, watermark.sortAt, watermark.recordId]
    );
  }

  /**
   * Ponto de partida da marca d'agua na primeira execucao: ate onde o mirror
   * ja chegou. Custa um seq scan em mirror.raw_payloads, mas roda uma unica
   * vez — depois disso a marca avanca sozinha.
   *
   * Inicializar por aqui (em vez de NOW()) evita pular silenciosamente o que
   * entrou no OMS enquanto o sync esteve parado.
   */
  async findMirrorMaxSortAt(): Promise<Date | null> {
    const result = await this.pool.query<{ max_sort_at: Date | null }>(
      `SELECT max(COALESCE(received_at, processed_at)) AS max_sort_at FROM mirror.raw_payloads`
    );

    return result.rows[0]?.max_sort_at ?? null;
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

  /**
   * Enfileira candidatos ausentes no mirror. A dedup principal ja e feita
   * antes (findExistingRawPayloadIds); o ON CONFLICT garante idempotencia da
   * fila efemera por (table_name, record_id).
   */
  async enqueueBackfill(candidates: RawPayloadCandidate[]): Promise<number> {
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
          INSERT INTO integration.sync_queue (
            table_name,
            record_id,
            operation,
            payload,
            retries,
            created_at,
            next_retry_at
          )
          VALUES ('raw_payloads', $1, 'INSERT', $2::jsonb, 0, NOW(), NULL)
          ON CONFLICT (table_name, record_id) DO NOTHING
        `,
        [item.id, JSON.stringify(payload)]
      );

      inserted += result.rowCount ?? 0;
    }

    return inserted;
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
        FROM integration.sync_queue
        WHERE retries < $1
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

  /**
   * Fila efemera: no sucesso removemos a linha da fila. A verdade do
   * "foi sincronizado" e o proprio mirror.raw_payloads, entao nao ha
   * necessidade de manter historico na fila (evita inflar o CORE).
   */
  async markSynced(eventId: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM integration.sync_queue WHERE id = $1`,
      [eventId]
    );
  }

  async markFailed(event: SyncEventRow, errorMessage: string): Promise<number> {
    const nextAttempt = event.retries + 1;
    const nextRetryAt = getNextRetryAt(nextAttempt);

    const result = await this.pool.query<{ retries: number }>(
      `
        UPDATE integration.sync_queue
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
      `DELETE FROM integration.sync_queue WHERE id = $1`,
      [event.id]
    );
  }

  /**
   * Politica de retencao da DLQ para nao acumular indefinidamente no CORE.
   * Remove registros mais antigos que o periodo informado.
   */
  async purgeExpiredDeadLetters(retentionDays: number): Promise<number> {
    const bounded = Math.min(Math.max(Math.floor(retentionDays), 1), 365);
    const result = await this.pool.query(
      `DELETE FROM integration.failed_jobs WHERE moved_at < NOW() - ($1 * INTERVAL '1 day')`,
      [bounded]
    );

    return result.rowCount ?? 0;
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
