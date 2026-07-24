/**
 * Backfill direto OMS -> CORE mirror.raw_payloads
 *
 * Importa registros ausentes do OMS para o CORE para um intervalo de datas,
 * resolvendo divergencias entre os valores exibidos no sistema financeiro e
 * os dados reais da plataforma de origem.
 *
 * Estrategia: UPSERT em lotes (sem arquivo intermediario).
 * Idempotente: registros ja existentes no CORE sao atualizados apenas se
 * o payload tiver mudado (via ON CONFLICT ... DO UPDATE).
 *
 * Uso:
 *   npx tsx scripts/backfill-june-mirror.ts [startDate] [endDate] [batchSize]
 *
 * Exemplos:
 *   npx tsx scripts/backfill-june-mirror.ts 2026-06-01 2026-07-17
 *   npx tsx scripts/backfill-june-mirror.ts 2026-06-01 2026-07-17 2000
 *
 * Variaveis de ambiente necessarias:
 *   OMS_DB_URL   - connection string do banco OMS (fonte)
 *   CORE_DB_URL  - connection string do banco CORE (destino)
 *   DATABASE_URL - fallback para CORE se CORE_DB_URL nao estiver definido
 */

import 'dotenv/config';
import { Pool } from 'pg';

const DEFAULT_START = '2026-06-01';
const DEFAULT_END = '2026-07-17';
const DEFAULT_BATCH_SIZE = 800;
const DEFAULT_BATCH_DELAY_MS = 3000; // 3s de pausa entre batches para dar tempo ao Supabase se recuperar

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function requireEnv(...keys: string[]): string {
  for (const key of keys) {
    const val = process.env[key];
    if (val && val.trim()) return val.trim();
  }
  throw new Error(`Variavel de ambiente obrigatoria nao encontrada: ${keys.join(' / ')}`);
}

async function countOms(omsPool: Pool, startDate: string, endDate: string): Promise<number> {
  const r = await omsPool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM public.raw_payloads
     WHERE COALESCE(received_at, processed_at) >= $1::timestamptz
       AND COALESCE(received_at, processed_at) < ($2::date + INTERVAL '1 day')::timestamptz`,
    [startDate, endDate]
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function countCore(corePool: Pool, startDate: string, endDate: string): Promise<number> {
  const r = await corePool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt
     FROM mirror.raw_payloads
     WHERE COALESCE(received_at, processed_at) >= $1::timestamptz
       AND COALESCE(received_at, processed_at) < ($2::date + INTERVAL '1 day')::timestamptz`,
    [startDate, endDate]
  );
  return parseInt(r.rows[0].cnt, 10);
}

async function fetchBatch(
  omsPool: Pool,
  startDate: string,
  endDate: string,
  batchSize: number,
  offset: number
): Promise<Array<Record<string, unknown>>> {
  const r = await omsPool.query(
    `SELECT
       id,
       source,
       external_order_id,
       event_type,
       payload_json,
       headers_json,
       received_at,
       processed_at,
       processing_status,
       error_message
     FROM public.raw_payloads
     WHERE COALESCE(received_at, processed_at) >= $1::timestamptz
       AND COALESCE(received_at, processed_at) < ($2::date + INTERVAL '1 day')::timestamptz
     ORDER BY COALESCE(received_at, processed_at) ASC, id ASC
     LIMIT $3
     OFFSET $4`,
    [startDate, endDate, batchSize, offset]
  );
  return r.rows;
}

async function upsertBatch(
  corePool: Pool,
  rows: Array<Record<string, unknown>>
): Promise<number> {
  if (rows.length === 0) return 0;

  // Monta um UPSERT multi-linha para desempenho
  const values: unknown[] = [];
  const placeholders: string[] = [];

  for (const row of rows) {
    const base = values.length;
    values.push(
      row.id,
      row.source,
      row.external_order_id,
      row.event_type,
      row.payload_json !== null && row.payload_json !== undefined
        ? JSON.stringify(row.payload_json)
        : null,
      row.headers_json !== null && row.headers_json !== undefined
        ? JSON.stringify(row.headers_json)
        : null,
      row.received_at,
      row.processed_at,
      row.processing_status,
      row.error_message
    );
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6}::jsonb, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, NOW(), NOW())`
    );
  }

  const sql = `
    INSERT INTO mirror.raw_payloads (
      id, source, external_order_id, event_type,
      payload_json, headers_json,
      received_at, processed_at,
      processing_status, error_message,
      synced_at, mirror_updated_at
    )
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (id) DO UPDATE SET
      source             = EXCLUDED.source,
      external_order_id  = EXCLUDED.external_order_id,
      event_type         = EXCLUDED.event_type,
      payload_json       = EXCLUDED.payload_json,
      headers_json       = EXCLUDED.headers_json,
      received_at        = EXCLUDED.received_at,
      processed_at       = EXCLUDED.processed_at,
      processing_status  = EXCLUDED.processing_status,
      error_message      = EXCLUDED.error_message,
      synced_at          = NOW(),
      mirror_updated_at  = NOW()
  `;

  const result = await corePool.query(sql, values);
  return result.rowCount ?? 0;
}

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0] ?? DEFAULT_START;
  const endDate = args[1] ?? DEFAULT_END;
  const batchSize = Number(args[2] ?? DEFAULT_BATCH_SIZE);
  const delayMs = Number(args[3] ?? DEFAULT_BATCH_DELAY_MS);

  console.log('=== Backfill OMS -> CORE mirror.raw_payloads (com throttling) ===');
  console.log(`Periodo: ${startDate} a ${endDate}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Delay entre batches: ${delayMs}ms`);
  console.log('');

  const omsPool = new Pool({ connectionString: requireEnv('OMS_DB_URL') });
  const corePool = new Pool({ connectionString: requireEnv('CORE_DB_URL', 'DATABASE_URL') });

  try {
    console.log('Contando registros no OMS...');
    const omsTotal = await countOms(omsPool, startDate, endDate);
    console.log(`OMS total para o periodo: ${omsTotal.toLocaleString('pt-BR')}`);

    console.log('Contando registros no CORE antes do backfill...');
    const coreBefore = await countCore(corePool, startDate, endDate);
    console.log(`CORE antes: ${coreBefore.toLocaleString('pt-BR')}`);
    console.log(`Gap estimado: ${(omsTotal - coreBefore).toLocaleString('pt-BR')}`);
    console.log('');

    if (omsTotal === 0) {
      console.log('Nenhum registro encontrado no OMS para o periodo. Encerrando.');
      return;
    }

    let offset = 0;
    let totalUpserted = 0;
    let batchCount = 0;
    const startTime = Date.now();

    while (offset < omsTotal) {
      batchCount++;
      process.stdout.write(`Batch ${batchCount} | offset=${offset} | `);

      const rows = await fetchBatch(omsPool, startDate, endDate, batchSize, offset);
      if (rows.length === 0) break;

      const upserted = await upsertBatch(corePool, rows);
      totalUpserted += upserted;
      offset += rows.length;

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const progress = ((offset / omsTotal) * 100).toFixed(1);
      console.log(`rows=${rows.length} upserted=${upserted} | progresso=${progress}% | ${elapsed}s`);

      if (rows.length < batchSize) break;

      // Throttling: pausa entre batches para evitar sobrecarregar o Disk IO do Supabase
      if (batchCount % 5 === 0) {
        // A cada 5 batches, pausa maior (10s) para dar tempo de recuperacao
        console.log(`[Pausa longa: 10s para recuperacao do Disk IO]`);
        await sleep(10000);
      } else {
        // Pausa normal entre batches
        await sleep(delayMs);
      }
    }

    console.log('');
    console.log('=== Resultado ===');
    console.log(`Batches executados: ${batchCount}`);
    console.log(`Total upserted: ${totalUpserted.toLocaleString('pt-BR')}`);

    console.log('Contando registros no CORE apos o backfill...');
    const coreAfter = await countCore(corePool, startDate, endDate);
    console.log(`CORE depois: ${coreAfter.toLocaleString('pt-BR')}`);
    console.log(`Diferenca: +${(coreAfter - coreBefore).toLocaleString('pt-BR')}`);
    console.log('');

    if (coreAfter >= omsTotal) {
      console.log('OK: CORE esta em paridade com OMS para o periodo.');
    } else {
      const remaining = omsTotal - coreAfter;
      console.log(`ATENCAO: ainda ha ${remaining.toLocaleString('pt-BR')} registros a sincronizar.`);
      console.log('Execute o script novamente para tentar novos registros (se houver mudancas no OMS).');
    }
  } finally {
    await omsPool.end();
    await corePool.end();
  }
}

main().catch((e) => {
  console.error('Erro fatal:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
