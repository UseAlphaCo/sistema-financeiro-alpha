import type { Pool } from "pg";

import { getNextRetryAt } from "../retry-policy";
import type {
  RawPayloadCandidate,
  RawPayloadRecord,
  ScanCursor,
  ScanPass,
  SyncControlStore,
  SyncEventRow,
  SyncWatermark,
} from "../types";

/**
 * Teto de linhas por upsert multi-row: 10 parametros por linha contra o limite
 * de 65.535 parametros do protocolo de extended query do Postgres.
 */
const MAX_UPSERT_BATCH = 6_500;

/** Ids por INSERT ao enfileirar reparo. Ver enqueueMissingIds. */
const ENQUEUE_SLICE = 10_000;

export type SweepStatus = {
  /** Linhas descobertas como ausentes e ainda nao trazidas do OMS. */
  pendingRepair: number;
  /** Null aqui significa "o ciclo nunca rodou" -- e um alarme, nao um vazio. */
  lastCycleAt: Date | null;
  /** Esperado 24 no cron horario. Menos que isso e ciclo morrendo. */
  okCyclesLast24h: number;
  cursors: {
    pass: string;
    nextBlock: number;
    lapEndBlock: number | null;
    lapNumber: number;
    lastRunAt: Date | null;
    lastProgressAt: Date | null;
    consecutiveErrors: number;
  }[];
  /**
   * Frescor POR FONTE. Agregado nao serve: eship parou em 11/08 enquanto
   * anymarket e shopify seguiam recebendo, e um numero unico nao teria visto.
   */
  sources: {
    source: string;
    mirrorRows: number;
    lastReceivedAt: Date | null;
  }[];
};

export type CycleMetrics = {
  tailBlocks: number;
  auditBlocks: number;
  rowsSeen: number;
  rowsMissing: number;
  rowsRepaired: number;
  omsMs: number;
  coreMs: number;
  errorMessage?: string | null;
};

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

    // Cursor FISICO de varredura do heap do OMS. Uma linha por (stream, pass).
    // Ver scripts/sql/core-integration-sync-scan.sql para o DDL comentado.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS integration.sync_scan_cursor (
        stream TEXT NOT NULL,
        pass TEXT NOT NULL CHECK (pass IN ('tail', 'audit')),
        next_block BIGINT NOT NULL DEFAULT 0 CHECK (next_block >= 0),
        lap_start_block BIGINT NOT NULL DEFAULT 0,
        lap_end_block BIGINT,
        blocks_covered BIGINT NOT NULL DEFAULT 0,
        source_relfilenode TEXT,
        source_heap_blocks BIGINT,
        lap_number BIGINT NOT NULL DEFAULT 0,
        last_run_at TIMESTAMPTZ,
        last_progress_at TIMESTAMPTZ,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (stream, pass)
      )
    `);

    // Heartbeat: responde "o cron esta vivo?", que nenhuma tabela responde
    // hoje. Em 11/08 o cron morreu e nada no banco registrou esse fato.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS integration.sync_cycle_log (
        id BIGSERIAL PRIMARY KEY,
        stream TEXT NOT NULL,
        cycle_id UUID NOT NULL,
        trigger_source TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        outcome TEXT,
        tail_blocks BIGINT NOT NULL DEFAULT 0,
        audit_blocks BIGINT NOT NULL DEFAULT 0,
        rows_seen BIGINT NOT NULL DEFAULT 0,
        rows_missing BIGINT NOT NULL DEFAULT 0,
        rows_repaired BIGINT NOT NULL DEFAULT 0,
        oms_ms INTEGER,
        core_ms INTEGER,
        error_message TEXT
      )
    `);

    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_cycle_log_started_at
        ON integration.sync_cycle_log (stream, started_at DESC)
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

  /**
   * Anti-join: devolve so os ids que o mirror NAO tem.
   *
   * unnest + LEFT JOIN em vez do `= ANY` de findExistingRawPayloadIds porque
   * este devolve o complemento (tipicamente pequeno) em vez do conjunto
   * presente (tipicamente quase tudo) -- menos trafego de volta. Medido:
   * 99.375 ids em ~5,5 s.
   */
  async findMissingRawPayloadIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    const result = await this.pool.query<{ id: string }>(
      `
        SELECT u.id
        FROM unnest($1::uuid[]) AS u(id)
        LEFT JOIN mirror.raw_payloads m ON m.id = u.id
        WHERE m.id IS NULL
      `,
      [ids]
    );

    return result.rows.map((row) => row.id);
  }

  /**
   * Enfileira ids ausentes para reparo, em um unico round-trip.
   *
   * So o id -- sem payload. A fila antiga (enqueueBackfill) grava o payload
   * inteiro em jsonb, o que obriga a descoberta a pagar o custo de
   * transferencia (~330 linhas/s) antes de poder avancar o cursor. Com 1,39M
   * linhas de backlog isso trava a varredura na velocidade do link: medido em
   * producao, o cursor nao saia do primeiro chunk. Guardando so o id (~50 bytes
   * contra ~20 KB), descoberta e transferencia ficam desacopladas -- a
   * descoberta varre milhares de paginas por ciclo e a drenagem consome no
   * ritmo que a banda permitir.
   */
  async enqueueMissingIds(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    // Em fatias: durante a recuperacao um chunk de paginas pode trazer mais de
    // 100 mil ausentes, e um unico INSERT desse tamanho levou ~30 s medido
    // contra producao -- estourava o orcamento de descoberta sozinho.
    let inserted = 0;
    for (let index = 0; index < ids.length; index += ENQUEUE_SLICE) {
      const slice = ids.slice(index, index + ENQUEUE_SLICE);
      const result = await this.pool.query(
        `
          INSERT INTO integration.sync_queue
            (table_name, record_id, operation, payload, retries, created_at, next_retry_at)
          SELECT 'raw_payloads', u.id::text, 'FETCH', NULL, 0, NOW(), NULL
          FROM unnest($1::uuid[]) AS u(id)
          ON CONFLICT (table_name, record_id) DO NOTHING
        `,
        [slice]
      );
      inserted += result.rowCount ?? 0;
    }

    return inserted;
  }

  /**
   * Proximos ids a reparar.
   *
   * ORDER BY id (FIFO pela PK) e nao `retries DESC, id` como findPendingEvents:
   * com centenas de milhares de linhas na fila, ordenar por retries forca um
   * sort do conjunto inteiro a cada ciclo. Por id, o indice da PK atende e o
   * plano para no limite.
   */
  async findPendingFetchIds(limit: number, maxRetries: number): Promise<{ queueId: number; recordId: string }[]> {
    const result = await this.pool.query<{ id: string; record_id: string }>(
      `
        SELECT id, record_id
        FROM integration.sync_queue
        WHERE operation = 'FETCH'
          AND retries < $1
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
        ORDER BY id ASC
        LIMIT $2
      `,
      [maxRetries, limit]
    );

    return result.rows.map((row) => ({ queueId: Number(row.id), recordId: row.record_id }));
  }

  async markFetchSynced(recordIds: string[]): Promise<number> {
    if (recordIds.length === 0) return 0;

    const result = await this.pool.query(
      `
        DELETE FROM integration.sync_queue
        WHERE operation = 'FETCH' AND record_id = ANY($1::text[])
      `,
      [recordIds]
    );

    return result.rowCount ?? 0;
  }

  async markFetchFailed(recordIds: string[], errorMessage: string): Promise<void> {
    if (recordIds.length === 0) return;

    await this.pool.query(
      `
        UPDATE integration.sync_queue
        SET retries = retries + 1,
            error_message = LEFT($2, 1500),
            next_retry_at = NOW() + INTERVAL '5 minutes'
        WHERE operation = 'FETCH' AND record_id = ANY($1::text[])
      `,
      [recordIds, errorMessage]
    );
  }

  async countPendingFetch(): Promise<number> {
    const result = await this.pool.query<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM integration.sync_queue WHERE operation = 'FETCH'`
    );

    return Number(result.rows[0]?.cnt ?? 0);
  }

  /**
   * Estado da varredura para a tela /integracoes.
   *
   * A tela mostrava so metricas de ESFORCO (fetched/processed/failed): um
   * sistema com 51% de buraco exibia numeros verdes porque todos descreviam o
   * trabalho feito, nenhum o trabalho que falta. Estes campos sao de RESULTADO.
   *
   * Barato de proposito: le so tabelas do CORE (nada no OMS, onde um
   * COUNT(*) por fonte custa 12,5 s), entao pode ser chamado a cada abertura
   * da tela.
   */
  async getSweepStatus(stream: string): Promise<SweepStatus> {
    const cursors = await this.pool.query<{
      pass: string;
      next_block: string;
      lap_end_block: string | null;
      lap_number: string;
      last_run_at: Date | null;
      last_progress_at: Date | null;
      consecutive_errors: number;
    }>(
      `
        SELECT pass, next_block, lap_end_block, lap_number,
               last_run_at, last_progress_at, consecutive_errors
        FROM integration.sync_scan_cursor
        WHERE stream = $1
        ORDER BY pass
      `,
      [stream]
    );

    const freshness = await this.pool.query<{
      source: string | null;
      rows: string;
      last_received_at: Date | null;
    }>(
      `
        SELECT source, count(*)::text AS rows, max(received_at) AS last_received_at
        FROM mirror.raw_payloads
        GROUP BY source
        ORDER BY source
      `
    );

    // 'deadline' conta como saudavel: significa "trabalhou ate o orcamento
    // acabar", que e o desfecho NORMAL enquanto ha backlog. Contar so 'ok'
    // faria o indicador marcar zero durante toda a recuperacao e ensinaria
    // todo mundo a ignorar o alerta -- que e como o problema anterior
    // sobreviveu meses.
    const cycle = await this.pool.query<{ last_cycle_at: Date | null; ok_last_24h: string }>(
      `
        SELECT max(started_at) AS last_cycle_at,
               count(*) FILTER (
                 WHERE outcome IN ('ok', 'deadline')
                   AND started_at > NOW() - INTERVAL '24 hours'
               )::text AS ok_last_24h
        FROM integration.sync_cycle_log
        WHERE stream = $1
      `,
      [stream]
    );

    return {
      pendingRepair: await this.countPendingFetch(),
      lastCycleAt: cycle.rows[0]?.last_cycle_at ?? null,
      okCyclesLast24h: Number(cycle.rows[0]?.ok_last_24h ?? 0),
      cursors: cursors.rows.map((row) => ({
        pass: row.pass,
        nextBlock: Number(row.next_block),
        lapEndBlock: row.lap_end_block === null ? null : Number(row.lap_end_block),
        lapNumber: Number(row.lap_number),
        lastRunAt: row.last_run_at,
        lastProgressAt: row.last_progress_at,
        consecutiveErrors: row.consecutive_errors,
      })),
      sources: freshness.rows.map((row) => ({
        source: row.source ?? "(null)",
        mirrorRows: Number(row.rows),
        lastReceivedAt: row.last_received_at,
      })),
    };
  }

  /**
   * Cursor fisico de varredura. Cria a linha na primeira chamada.
   */
  async getScanCursor(stream: string, pass: ScanPass): Promise<ScanCursor> {
    await this.pool.query(
      `
        INSERT INTO integration.sync_scan_cursor (stream, pass)
        VALUES ($1, $2)
        ON CONFLICT (stream, pass) DO NOTHING
      `,
      [stream, pass]
    );

    const result = await this.pool.query<{
      next_block: string;
      lap_start_block: string;
      lap_end_block: string | null;
      blocks_covered: string;
      source_relfilenode: string | null;
      source_heap_blocks: string | null;
      lap_number: string;
      consecutive_errors: number;
      last_run_at: Date | null;
    }>(
      `
        SELECT next_block, lap_start_block, lap_end_block, blocks_covered,
               source_relfilenode, source_heap_blocks, lap_number, consecutive_errors,
               last_run_at
        FROM integration.sync_scan_cursor
        WHERE stream = $1 AND pass = $2
      `,
      [stream, pass]
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Cursor de varredura ausente para ${stream}/${pass}`);
    }

    return {
      stream,
      pass,
      nextBlock: Number(row.next_block),
      lapStartBlock: Number(row.lap_start_block),
      lapEndBlock: row.lap_end_block === null ? null : Number(row.lap_end_block),
      blocksCovered: Number(row.blocks_covered),
      sourceRelfilenode: row.source_relfilenode,
      sourceHeapBlocks: row.source_heap_blocks === null ? null : Number(row.source_heap_blocks),
      lapNumber: Number(row.lap_number),
      consecutiveErrors: row.consecutive_errors,
      lastRunAt: row.last_run_at,
    };
  }

  /**
   * Grava o cursor. `progressed` separa "rodou" de "andou": um ciclo que roda
   * toda hora sem avancar (cursor alem do fim do heap, por exemplo) e
   * indistinguivel de saude se so existir last_run_at.
   */
  async saveScanCursor(cursor: ScanCursor, progressed: boolean): Promise<void> {
    await this.pool.query(
      `
        UPDATE integration.sync_scan_cursor
        SET next_block = $3,
            lap_start_block = $4,
            lap_end_block = $5,
            blocks_covered = $6,
            source_relfilenode = $7,
            source_heap_blocks = $8,
            lap_number = $9,
            consecutive_errors = $10,
            last_run_at = NOW(),
            last_progress_at = CASE WHEN $11 THEN NOW() ELSE last_progress_at END,
            updated_at = NOW()
        WHERE stream = $1 AND pass = $2
      `,
      [
        cursor.stream,
        cursor.pass,
        cursor.nextBlock,
        cursor.lapStartBlock,
        cursor.lapEndBlock,
        cursor.blocksCovered,
        cursor.sourceRelfilenode,
        cursor.sourceHeapBlocks,
        cursor.lapNumber,
        cursor.consecutiveErrors,
        progressed,
      ]
    );
  }

  /**
   * Upsert multi-row no mirror. Promovido de scripts/backfill-mirror-window.ts,
   * onde ja rodava em producao.
   *
   * Teto de 6.500 linhas por lote: sao 10 parametros por linha contra o limite
   * de 65.535 parametros do protocolo de extended query do Postgres.
   */
  async upsertRawPayloadsBatch(records: RawPayloadRecord[]): Promise<number> {
    if (records.length === 0) {
      return 0;
    }

    if (records.length > MAX_UPSERT_BATCH) {
      throw new Error(
        `Lote de ${records.length} linhas excede o teto de ${MAX_UPSERT_BATCH} (limite de 65.535 parametros)`
      );
    }

    const values: unknown[] = [];
    const tuples = records.map((record, index) => {
      const base = index * 10;
      values.push(
        record.id,
        record.source,
        record.externalOrderId,
        record.eventType,
        record.payloadJson,
        record.headersJson,
        record.receivedAt,
        record.processedAt,
        record.processingStatus,
        record.errorMessage
      );
      return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}::jsonb, $${base + 7}::timestamptz, $${base + 8}::timestamptz, $${base + 9}, $${base + 10}, NOW(), NOW())`;
    });

    const result = await this.pool.query(
      `
        INSERT INTO mirror.raw_payloads (
          id, source, external_order_id, event_type, payload_json, headers_json,
          received_at, processed_at, processing_status, error_message,
          synced_at, mirror_updated_at
        ) VALUES ${tuples.join(", ")}
        ON CONFLICT (id) DO UPDATE SET
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
      values
    );

    return result.rowCount ?? 0;
  }

  async startCycleLog(stream: string, cycleId: string, triggerSource: string): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      `
        INSERT INTO integration.sync_cycle_log (stream, cycle_id, trigger_source)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [stream, cycleId, triggerSource]
    );

    return Number(result.rows[0]?.id ?? 0);
  }

  async finishCycleLog(logId: number, outcome: string, metrics: CycleMetrics): Promise<void> {
    if (logId <= 0) return;

    await this.pool.query(
      `
        UPDATE integration.sync_cycle_log
        SET finished_at = NOW(),
            outcome = $2,
            tail_blocks = $3,
            audit_blocks = $4,
            rows_seen = $5,
            rows_missing = $6,
            rows_repaired = $7,
            oms_ms = $8,
            core_ms = $9,
            error_message = LEFT($10, 1500)
        WHERE id = $1
      `,
      [
        logId,
        outcome,
        metrics.tailBlocks,
        metrics.auditBlocks,
        metrics.rowsSeen,
        metrics.rowsMissing,
        metrics.rowsRepaired,
        metrics.omsMs,
        metrics.coreMs,
        metrics.errorMessage ?? null,
      ]
    );
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
      // operation <> 'FETCH': as linhas de reparo da varredura fisica sao
      // drenadas por findPendingFetchIds, que busca o payload no OMS. Se
      // caissem aqui, o laco legado as trataria como evento invalido (payload
      // nulo) e as mandaria para a DLQ apos MAX_RETRIES.
      `
        SELECT id, table_name, record_id, operation, payload, retries, next_retry_at
        FROM integration.sync_queue
        WHERE operation <> 'FETCH'
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
