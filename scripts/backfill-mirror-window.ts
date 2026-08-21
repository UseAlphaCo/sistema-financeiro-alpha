/**
 * Carga em bloco OMS -> CORE mirror.raw_payloads, por janela de datas.
 *
 * Importa registros ausentes do OMS para o CORE, resolvendo divergencias entre
 * os valores exibidos no sistema financeiro e os dados reais da plataforma de
 * origem. E o caminho previsto em §2.4 do plano de correcao de consumo para
 * fechar lacunas que o backfill automatico nao alcanca -- ver
 * docs/PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md.
 *
 * Estrategia: UPSERT em lotes, sem arquivo intermediario. Substitui as Fases 2
 * e 3 de docs/RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md (que dependem de `psql
 * \copy` via CSV) com o mesmo resultado: as mesmas 10 colunas, o mesmo
 * ON CONFLICT (id) DO UPDATE, `synced_at`/`mirror_updated_at` preenchidos do
 * lado do CORE. Idempotente: reexecutar e seguro e reprocessa sem duplicar.
 *
 * IMPORTANTE -- depois de rodar isto, avance a marca d'agua do sync incremental
 * (§2.4 Passo 1b do plano). A carga escreve no mirror por fora do worker, entao
 * `integration.sync_watermark` nao se move, e o ciclo incremental fica preso
 * atras da regiao ja carregada avancando so 200 linhas por invocacao.
 *
 * Uso:
 *   npx tsx scripts/backfill-mirror-window.ts <startDate> <endDate> [batchSize] [delayMs]
 *
 * Exemplos:
 *   npx tsx scripts/backfill-mirror-window.ts 2026-08-01 2026-08-18
 *   npx tsx scripts/backfill-mirror-window.ts 2026-08-01 2026-08-18 800 3000
 *
 * O piso do mirror vale aqui: `startDate` anterior a SYNC_MIRROR_FLOOR_AT
 * aborta, e so passa com `--allow-below-floor`. Ver MIRROR_FLOOR_AT abaixo.
 *
 * Variaveis de ambiente necessarias:
 *   OMS_DB_URL   - connection string do banco OMS (fonte, somente leitura)
 *   CORE_DB_URL  - connection string do banco CORE (destino)
 *   DATABASE_URL - fallback para CORE se CORE_DB_URL nao estiver definido
 *
 * Opcional:
 *   SYNC_MIRROR_FLOOR_AT - piso de data do mirror (default 2026-08-01T00:00-03)
 */

import 'dotenv/config';
import { Pool, type QueryResult, type QueryResultRow } from 'pg';

const DEFAULT_START = '2026-08-01';
const DEFAULT_END = '2026-08-18';

/**
 * Lote grande de proposito. `public.raw_payloads` no OMS **nao tem indice em
 * `received_at` nem `processed_at`** (medido em 2026-08-18: so a PK em `id`,
 * um btree em `(source, external_order_id)` e um parcial de
 * `processing_status='failed'`). Consequencia: a consulta por janela de data e
 * sempre um Parallel Seq Scan de 2,16M linhas / 5,9 GB -- ~80s -- **custo
 * identico qualquer que seja o LIMIT**.
 *
 * Logo o tamanho do lote e a unica alavanca real de tempo total: 800 linhas por
 * varredura dava ~560 varreduras (~12h); 5.000 da ~90 (~2h).
 *
 * Teto de 6.500: o UPSERT monta um INSERT multi-linha com 10 parametros por
 * linha, e o protocolo do Postgres limita a 65.535 parametros por consulta.
 */
const DEFAULT_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 6500;

/**
 * Piso de data do mirror, igual ao SYNC_MIRROR_FLOOR_AT do worker.
 *
 * Este script escreve direto em mirror.raw_payloads, por fora do worker, entao
 * o piso do worker nao o alcanca: `startDate` anterior a 01/08/2026 traria de
 * volta parte das 604.418 linhas que o truncate de 2026-08-21 tirou de
 * proposito. O guarda pede confirmacao explicita em vez de recusar, porque
 * mover o piso e uma decisao legitima -- so nao pode ser acidental.
 */
const MIRROR_FLOOR_AT = new Date(
  process.env.SYNC_MIRROR_FLOOR_AT ?? '2026-08-01T00:00:00-03:00'
);
const DEFAULT_BATCH_DELAY_MS = 3000; // 3s de pausa entre batches para dar tempo ao Supabase se recuperar

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Toda leitura do OMS passa por aqui. O `options: -c
 * default_transaction_read_only=on` de um Pool nao basta: confirmado contra o
 * pooler real (Supavisor, aws-*.pooler.supabase.com:5432) que o startup packet
 * do libpq e ignorado -- `SHOW default_transaction_read_only` voltava "off" e um
 * UPDATE de teste nao era rejeitado. A garantia so funciona como `SET`
 * explicito, na mesma conexao fisica da query (por isso pool.connect() em vez
 * de pool.query()), antes de qualquer outra instrucao.
 *
 * Mesmo padrao de OmsRepository.query() em
 * src/workers/sync/repositories/oms-repository.ts -- este script fala com o
 * mesmo banco e nao pode ter garantia mais fraca que a aplicacao.
 */
async function queryOmsReadOnly<T extends QueryResultRow = QueryResultRow>(
  omsPool: Pool,
  text: string,
  values?: unknown[]
): Promise<QueryResult<T>> {
  const client = await omsPool.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    return await client.query<T>(text, values as unknown[]);
  } finally {
    client.release();
  }
}

function requireEnv(...keys: string[]): string {
  for (const key of keys) {
    const val = process.env[key];
    if (val && val.trim()) return val.trim();
  }
  throw new Error(`Variavel de ambiente obrigatoria nao encontrada: ${keys.join(' / ')}`);
}

async function countOms(omsPool: Pool, startDate: string, endDate: string): Promise<number> {
  const r = await queryOmsReadOnly<{ cnt: string }>(
    omsPool,
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

/**
 * Cursor do keyset. `sortAt` null significa "inicio da janela".
 */
type Cursor = { sortAt: Date | null; recordId: string };

/**
 * Paginacao por keyset, nao por OFFSET.
 *
 * Com OFFSET, cada lote fazia o Postgres varrer e descartar `offset` linhas
 * antes de devolver as proximas: custo O(n^2) sobre uma tabela cujas linhas tem
 * payload de 10-30KB. Nos ultimos lotes de uma janela de ~75 mil linhas isso
 * significa descartar ~74 mil linhas por consulta -- exatamente o padrao que
 * produziu o `Query read timeout` que derrubou o cron em 2026-08-11.
 *
 * O keyset `(COALESCE(received_at, processed_at), id::text) > (cursor)` usa a
 * mesma ordenacao total de OmsRepository.findRawPayloadsAfter(), entao o custo
 * por lote e constante e a varredura nunca reprocessa o que ja passou. O
 * `id::text` (em vez de `id`) mantem a ordenacao identica a do worker: uuid e
 * text ordenam diferente, e divergir aqui abriria lacuna na fronteira do lote.
 */
async function fetchBatch(
  omsPool: Pool,
  startDate: string,
  endDate: string,
  batchSize: number,
  cursor: Cursor
): Promise<Array<Record<string, unknown>>> {
  const r = await queryOmsReadOnly(
    omsPool,
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
       AND ($4::timestamptz IS NULL
            OR (COALESCE(received_at, processed_at), id::text) > ($4::timestamptz, $5::text))
     ORDER BY COALESCE(received_at, processed_at) ASC, id::text ASC
     LIMIT $3`,
    [startDate, endDate, batchSize, cursor.sortAt, cursor.recordId]
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

/**
 * Retomada: `--resume-from=<ISO>,<uuid>`, com o valor que o proprio script
 * imprime como `cursor=` ao fim de cada lote.
 *
 * Numa janela grande a execucao leva horas. Sem isto, uma queda no meio faz o
 * cursor voltar a `null` e retransferir tudo -- correto, porque o UPSERT e
 * idempotente, mas desperdica a execucao inteira. Nao da para derivar o ponto
 * de retomada do mirror automaticamente: ele pode ja conter linhas *depois* da
 * lacuna (o incremental trouxe os pedidos de hoje), entao o maximo presente no
 * mirror pularia justamente o buraco.
 */
function parseResumeFrom(args: string[]): { sortAt: Date; recordId: string } | null {
  const raw = args.find((a) => a.startsWith('--resume-from='))?.slice('--resume-from='.length);
  if (!raw) return null;

  const [iso, recordId] = raw.split(',');
  if (!iso || !recordId) {
    throw new Error('--resume-from espera <ISO>,<uuid> (o valor impresso como cursor= pelo script)');
  }

  const sortAt = new Date(iso);
  if (Number.isNaN(sortAt.getTime())) {
    throw new Error(`--resume-from com data invalida: ${iso}`);
  }

  return { sortAt, recordId };
}

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const startDate = positional[0] ?? DEFAULT_START;
  const endDate = positional[1] ?? DEFAULT_END;
  const batchSizePedido = Number(positional[2] ?? DEFAULT_BATCH_SIZE);
  const delayMs = Number(positional[3] ?? DEFAULT_BATCH_DELAY_MS);
  const resumeFrom = parseResumeFrom(args);

  if (!Number.isFinite(batchSizePedido) || batchSizePedido < 1) {
    throw new Error(`batchSize invalido: ${positional[2]}`);
  }

  if (Number.isNaN(MIRROR_FLOOR_AT.getTime())) {
    throw new Error(`SYNC_MIRROR_FLOOR_AT invalida: ${process.env.SYNC_MIRROR_FLOOR_AT}`);
  }

  // Comparacao por data de calendario, e nao por instante: o piso e
  // 2026-08-01T00:00:00-03 (03:00Z) e `startDate` chega como 'YYYY-MM-DD', que
  // o Postgres resolve na timezone da sessao (UTC no pooler). Comparar
  // instantes marcaria o proprio 2026-08-01 como abaixo do piso, por tres
  // horas. Datas ISO em string comparam corretamente por ordem lexicografica.
  const floorDay = MIRROR_FLOOR_AT.toISOString().slice(0, 10);
  if (startDate < floorDay && !args.includes('--allow-below-floor')) {
    throw new Error(
      `startDate ${startDate} e anterior ao piso do mirror (${floorDay}). ` +
        `O mirror cobre so a janela a partir do piso desde 2026-08-21; carregar ` +
        `antes disso desfaz o truncate e traz de volta o consumo que congelou a ` +
        `producao em 11/08. Se o piso mudou, ajuste SYNC_MIRROR_FLOOR_AT; se e ` +
        `carga pontual deliberada, repita com --allow-below-floor.`
    );
  }
  const batchSize = Math.min(batchSizePedido, MAX_BATCH_SIZE);
  if (batchSize !== batchSizePedido) {
    console.log(
      `Aviso: batchSize reduzido de ${batchSizePedido} para ${MAX_BATCH_SIZE} ` +
        `(limite de 65.535 parametros por consulta do Postgres, a 10 por linha)`
    );
  }

  console.log('=== Backfill OMS -> CORE mirror.raw_payloads (com throttling) ===');
  console.log(`Periodo: ${startDate} a ${endDate}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Delay entre batches: ${delayMs}ms`);
  if (resumeFrom) {
    console.log(`Retomando de: ${resumeFrom.sortAt.toISOString()} , ${resumeFrom.recordId}`);
  }
  console.log('');

  // Mesmo endurecimento de src/workers/sync/db.ts, com statement_timeout muito
  // maior. Os 30s de la sao dimensionados para o caminho de request -- e sao
  // justamente o motivo do `Query read timeout` que derrubou o cron em
  // 2026-08-11: sem indice em received_at/processed_at no OMS, a consulta por
  // janela de data leva ~80s. Aqui isso e' esperado e tolerado; no worker e' um
  // defeito a corrigir (ver o plano de correcao de consumo).
  //
  // `options` fica como defesa em profundidade -- a garantia de read-only e o
  // SET explicito de queryOmsReadOnly().
  const POOL_CONNECT_TIMEOUT_MS = 10_000;
  const POOL_STATEMENT_TIMEOUT_MS = 300_000;

  const omsPool = new Pool({
    connectionString: requireEnv('OMS_DB_URL'),
    application_name: 'alp-core-fin-backfill-mirror-window-oms',
    options: '-c default_transaction_read_only=on',
    max: 2,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    query_timeout: POOL_STATEMENT_TIMEOUT_MS,
  });
  const corePool = new Pool({
    connectionString: requireEnv('CORE_DB_URL', 'DATABASE_URL'),
    application_name: 'alp-core-fin-backfill-mirror-window-core',
    max: 2,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
    statement_timeout: POOL_STATEMENT_TIMEOUT_MS,
    query_timeout: POOL_STATEMENT_TIMEOUT_MS,
  });

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

    let cursor: Cursor = { sortAt: null, recordId: '' };
    let lidas = 0;
    let totalUpserted = 0;
    let batchCount = 0;
    const startTime = Date.now();

    // Sem `while (lidas < omsTotal)`: omsTotal e uma foto do inicio, e o keyset
    // termina por conta propria quando o lote vem incompleto. Linhas que
    // entrarem no OMS durante a execucao tem sort_at maior e serao alcancadas
    // pelo ciclo incremental, nao por aqui.
    for (;;) {
      batchCount++;
      process.stdout.write(`Batch ${batchCount} | lidas=${lidas} | `);

      const rows = await fetchBatch(omsPool, startDate, endDate, batchSize, cursor);
      if (rows.length === 0) break;

      const upserted = await upsertBatch(corePool, rows);
      totalUpserted += upserted;
      lidas += rows.length;

      // Avanca o cursor para a ultima linha lida do lote (a maior do keyset,
      // porque a leitura e ASC).
      const last = rows[rows.length - 1];
      const lastSortAt = (last.received_at ?? last.processed_at) as Date | null;
      if (!lastSortAt) {
        throw new Error(
          `Linha ${String(last.id)} sem received_at nem processed_at: nao ha por onde avancar o cursor`
        );
      }
      cursor = { sortAt: lastSortAt, recordId: String(last.id) };

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const progress = ((lidas / omsTotal) * 100).toFixed(1);
      console.log(
        `rows=${rows.length} upserted=${upserted} | progresso=${progress}% | ${elapsed}s\n` +
          `  cursor=${lastSortAt.toISOString()},${String(last.id)}`
      );

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
