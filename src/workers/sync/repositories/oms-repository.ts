import type { Pool, QueryResult, QueryResultRow } from "pg";

import type { RawPayloadCandidate } from "../types";

/**
 * OMS: fonte de leitura de raw_payloads, e nada mais. Nao ha mais metodo de
 * escrita/controle tecnico nesta classe -- foram removidos junto com o
 * fallback SYNC_CONTROL_TARGET=oms, que so existia como rollback de
 * emergencia e ficou estruturalmente inutilizavel quando o read-only do OMS
 * passou a ser aplicado de verdade (ver query() abaixo). O controle tecnico
 * (fila/retry/DLQ/lock) vive exclusivamente no CORE, via CoreRepository.
 */
export class OmsRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * O `options: -c default_transaction_read_only=on` do Pool (ver db.ts) e
   * necessario mas nao suficiente: confirmado contra o pooler real (Supavisor,
   * aws-*.pooler.supabase.com:5432) que o startup packet do libpq e ignorado
   * -- `SHOW default_transaction_read_only` voltava "off", e ate
   * `application_name` chegava sobrescrito como "Supavisor" em vez do valor
   * pedido pelo client. A garantia so funciona como `SET` explicito, na mesma
   * conexao fisica da query (por isso pool.connect() em vez de pool.query()),
   * antes de qualquer outra instrucao nessa conexao.
   */
  private async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<QueryResult<T>> {
    const client = await this.pool.connect();
    try {
      await client.query("SET default_transaction_read_only = on");
      return await client.query<T>(text, values as unknown[]);
    } finally {
      client.release();
    }
  }

  /**
   * Descoberta incremental: le apenas o que entrou depois da marca d'agua,
   * em ordem ascendente de (sort_at, id), onde sort_at e
   * COALESCE(received_at, processed_at).
   *
   * Substitui o rescan de janela fixa no ciclo automatico. Duas diferencas
   * que importam em relacao a findRawPayloadCandidates:
   *
   * - ASC em vez de DESC: o cursor caminha para frente e nunca deixa uma
   *   lacuna para tras. O DESC com LIMIT so enxergava os N mais recentes,
   *   entao buracos anteriores a eles eram inalcancaveis por construcao.
   * - O LIMIT recorta o proximo lote a partir do cursor, nao os N mais
   *   recentes de toda a janela — cada ciclo processa material novo.
   *
   * Linhas sem received_at e sem processed_at ficam de fora: nao ha por onde
   * ordena-las de forma estavel. Sao alcancadas pelo backfill por janela.
   */
  async findRawPayloadsAfter(
    watermark: { sortAt: Date; recordId: string },
    limit: number
  ): Promise<RawPayloadCandidate[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 5000);

    const result = await this.query<{
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
        WHERE COALESCE(rp.received_at, rp.processed_at) IS NOT NULL
          AND (COALESCE(rp.received_at, rp.processed_at), rp.id::text) > ($1::timestamptz, $2::text)
        ORDER BY COALESCE(rp.received_at, rp.processed_at) ASC, rp.id::text ASC
        LIMIT $3
      `,
      [watermark.sortAt, watermark.recordId, boundedLimit]
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

  async findRawPayloadCandidates(days: 30 | 60 | 90, limit: number): Promise<RawPayloadCandidate[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 5000);

    const result = await this.query<{
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
}
