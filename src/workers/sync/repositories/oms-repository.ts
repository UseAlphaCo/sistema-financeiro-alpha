import type { Pool, QueryResult, QueryResultRow } from "pg";

import type { OmsHeapState, RawPayloadCandidate, RawPayloadKey } from "../types";

/**
 * Colunas completas de raw_payloads. Usado so na busca por PK dos ausentes --
 * a descoberta usa RAW_PAYLOAD_KEY_COLUMNS, que nao toca no TOAST.
 */
const RAW_PAYLOAD_FULL_COLUMNS = `
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
`;

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
   * Estado fisico do heap: identidade do arquivo e tamanho real.
   *
   * `pg_relation_size` le o tamanho do arquivo (exato); `pg_class.relpages` e
   * estimativa que so e atualizada por VACUUM/ANALYZE -- em 2026-08-18 estava
   * 1.370 paginas atras (199.528 contra 200.898), o que faria a cauda parar
   * antes do fim do heap e perder o que chegou nesse intervalo.
   */
  async getHeapState(): Promise<OmsHeapState> {
    const result = await this.query<{ relfilenode: string; heap_blocks: string }>(
      `
        SELECT c.relfilenode::text AS relfilenode,
               (pg_relation_size(c.oid) / current_setting('block_size')::bigint)::text AS heap_blocks
        FROM pg_class c
        WHERE c.oid = 'public.raw_payloads'::regclass
      `
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("public.raw_payloads nao encontrada no OMS");
    }

    return { relfilenode: row.relfilenode, heapBlocks: Number(row.heap_blocks) };
  }

  /**
   * Descoberta por faixa fisica de paginas: [fromBlock, toBlock).
   *
   * Por que ctid e nao received_at: o OMS nao tem indice em received_at nem em
   * processed_at, e nao podemos criar (read-only). O keyset temporal vira
   * Parallel Seq Scan de ~80 s contra um statement_timeout de 30 s, ou seja
   * falha sempre. O ctid e o unico caminho de acesso que existe sem DDL --
   * PG 17 resolve esta faixa com Tid Range Scan (medido: 10.000 paginas =
   * 108.461 linhas em 4,0 s, ja sob o timeout de 30 s).
   *
   * Confirmado por EXPLAIN que o planner mantem o Tid Range Scan com os
   * limites vindo como parametro ($1/$2), entao nao ha necessidade de
   * interpolar literais.
   *
   * NUNCA acrescentar LIMIT aqui. A fronteira de um chunk e sempre uma pagina
   * inteira; um LIMIT seguido do avanco do cursor descartaria o resto da faixa
   * em silencio -- exatamente a classe de buraco que este desenho existe para
   * eliminar.
   */
  async findKeysInPageRange(fromBlock: number, toBlock: number): Promise<RawPayloadKey[]> {
    const from = Math.max(Math.floor(fromBlock), 0);
    const to = Math.max(Math.floor(toBlock), from);

    if (to === from) {
      return [];
    }

    const result = await this.query<{
      id: string;
      source: string | null;
      received_at: Date | null;
      processed_at: Date | null;
      processing_status: string | null;
    }>(
      `
        SELECT rp.id, rp.source, rp.received_at, rp.processed_at, rp.processing_status
        FROM raw_payloads rp
        WHERE rp.ctid >= $1::tid AND rp.ctid < $2::tid
      `,
      [`(${from},0)`, `(${to},0)`]
    );

    return result.rows.map((row) => ({
      id: row.id,
      source: row.source,
      receivedAt: row.received_at,
      processedAt: row.processed_at,
      processingStatus: row.processing_status,
    }));
  }

  /**
   * Busca alvo dos ausentes, por chave primaria. E o unico ponto que paga o
   * custo do TOAST: medido em ~330 linhas/s, limitado por banda e nao por
   * concorrencia (4 conexoes em paralelo deram 317 linhas/s -- paralelizar so
   * sobrecarrega o OMS sem ganho).
   *
   * Pode devolver MENOS linhas que ids pedidos, quando a linha foi apagada no
   * OMS entre a descoberta e a busca. Quem chama tem de tratar o residuo
   * explicitamente, nunca descartar em silencio.
   */
  async findRawPayloadsByIds(ids: string[]): Promise<RawPayloadCandidate[]> {
    if (ids.length === 0) {
      return [];
    }

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
        SELECT ${RAW_PAYLOAD_FULL_COLUMNS}
        FROM raw_payloads rp
        WHERE rp.id = ANY($1::uuid[])
      `,
      [ids]
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

  /**
   * Descoberta incremental: le apenas o que entrou depois da marca d'agua,
   * em ordem ascendente de (sort_at, id), onde sort_at e
   * COALESCE(received_at, processed_at).
   *
   * Substituiu o rescan de janela fixa no ciclo automatico (removido em
   * 2026-08-24), que ordenava DESC com LIMIT e por isso so enxergava os N mais
   * recentes -- buracos anteriores a eles eram inalcancaveis por construcao.
   * Aqui o LIMIT recorta o proximo lote a partir do cursor, entao cada ciclo
   * processa material novo.
   *
   * ATENCAO: depende de um indice por (received_at, processed_at) que o OMS nao
   * tem, entao na pratica estoura o statement_timeout. Mantido apenas como
   * rollback do modo ctid; ver a pendencia registrada no plano.
   *
   * Linhas sem received_at e sem processed_at ficam de fora: nao ha por onde
   * ordena-las de forma estavel. Sao alcancadas por
   * scripts/backfill-mirror-window.ts.
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

}
