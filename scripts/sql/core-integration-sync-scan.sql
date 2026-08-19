-- DDL DE REFERENCIA -- controle da varredura por cursor fisico (CORE).
--
-- Estas tabelas sao criadas em runtime, de forma idempotente, por
-- CoreRepository.ensureInfrastructure() (src/workers/sync/repositories/core-repository.ts).
-- Este arquivo existe para leitura e para aplicacao manual em ambiente novo.
--
-- NAO virar migration do Prisma: o deploy roda apenas `prisma generate && next
-- build`, sem `migrate deploy`, e nenhuma tabela de `integration`/`mirror` esta
-- no schema.prisma -- uma migration aqui dispararia drift/reset.
--
-- Contexto: docs/PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md e o cabecalho de
-- src/workers/sync/page-cursor-sync.ts.


-- ============================================================================
-- POR QUE UM CURSOR FISICO
-- ============================================================================
--
-- O OMS e read-only para esta aplicacao e public.raw_payloads nao tem indice em
-- received_at nem processed_at. Medido em 2026-08-18, contra producao:
--
--   descoberta por keyset de tempo   Parallel Seq Scan   79.785 ms
--   statement_timeout do worker                          30.000 ms
--
-- Ou seja: o ciclo de sync falhava por construcao, e falhava assim desde
-- sempre. O resultado foi um mirror com 51% das linhas que deveria ter (782.324
-- de 1.607.691 desde 01/06), sem ninguem perceber por meses.
--
-- O ctid e o unico caminho de acesso que existe sem DDL no OMS. PG 17 resolve
-- `ctid >= $1::tid AND ctid < $2::tid` com Tid Range Scan:
--
--   descoberta por faixa de paginas  Tid Range Scan      4.065 ms / 10.000 pag
--
-- e o custo passa a ser proporcional a PAGINAS VARRIDAS -- numero escolhido por
-- nos -- em vez de ao tamanho da tabela.


-- ============================================================================
-- 1. CURSOR DE VARREDURA
-- ============================================================================
--
-- Uma linha por (stream, pass). Sao dois cursores independentes:
--
--   tail   latencia. Cursor proprio com lookback de 500 paginas, ate o fim
--          atual do heap. Tem memoria de proposito -- "as ultimas N paginas"
--          nao alcancaria depois de uma parada de dias.
--
--   audit  completude. Volta ciclica pela tabela inteira, com lap_end_block
--          CONGELADO no tamanho do heap quando a volta comecou.
--
-- A auditoria nao e rede de seguranca, e o mecanismo principal: com 377.693
-- tuplas mortas o FSM reaproveita espaco e linha nova cai em pagina velha
-- rotineiramente (a correlacao de received_at ser 0,954 e nao 1,0 mede
-- exatamente essa fracao). Uma cauda pura perderia essas linhas para sempre.

CREATE TABLE IF NOT EXISTS integration.sync_scan_cursor (
  stream              TEXT   NOT NULL,
  pass                TEXT   NOT NULL CHECK (pass IN ('tail', 'audit')),

  -- Proxima pagina a ler, inclusiva. BLOCO, nunca tid: a fronteira de um chunk
  -- e sempre uma pagina inteira. Guardar um tid convidaria a retomar no meio de
  -- um bloco depois de um LIMIT, o que abriria um buraco periodico.
  next_block          BIGINT NOT NULL DEFAULT 0 CHECK (next_block >= 0),

  -- Horizonte da volta, congelado no inicio. Sem isso, numa tabela que cresce
  -- ~1.700 paginas/dia, a volta persegue o fim e NUNCA fecha -- e a regra das
  -- duas voltas nunca produz garantia nenhuma.
  lap_start_block     BIGINT NOT NULL DEFAULT 0,
  lap_end_block       BIGINT,

  -- Sustenta a invariante "a volta cobriu mesmo tudo":
  --   blocks_covered = lap_end_block - lap_start_block
  -- Sem ela, "a volta terminou" e suposicao; com ela, e assercao que falha alto.
  blocks_covered      BIGINT NOT NULL DEFAULT 0,

  -- A COLUNA MAIS IMPORTANTE DA TABELA.
  -- VACUUM FULL, CLUSTER, pg_repack e TRUNCATE trocam o relfilenode e invalidam
  -- TODOS os ctid de uma vez. Sem comparar isto a cada ciclo, o cursor passa a
  -- apontar para alem do fim de um heap menor, a consulta devolve zero linhas
  -- SEM ERRO, e o log registra "ciclo ok" enquanto o mirror congela -- a
  -- assinatura de 11/08 outra vez, agora disfarcada de sucesso.
  -- VACUUM simples e ANALYZE NAO trocam (por isso pedir VACUUM ao DBA e seguro).
  source_relfilenode  TEXT,

  -- Detecta truncamento, alimenta o "% da volta" na tela e, por diferenca entre
  -- ciclos, mede de graca o reuso de FSM.
  source_heap_blocks  BIGINT,

  lap_number          BIGINT NOT NULL DEFAULT 0,

  -- Distinguem "rodou" de "andou". Um ciclo que roda toda hora sem avancar e
  -- indistinguivel de saude se so existir last_run_at.
  last_run_at         TIMESTAMPTZ,
  last_progress_at    TIMESTAMPTZ,

  -- Transforma "o cron esta morrendo ha dias" em WHERE consecutive_errors >= 3.
  consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,

  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (stream, pass)
);


-- ============================================================================
-- 2. LOG DE CICLOS (heartbeat)
-- ============================================================================
--
-- Existe por uma razao: `SELECT max(started_at)` responde "o cron esta vivo?".
-- integration.worker_sync_jobs nao responde -- registra jobs que comecaram,
-- mistura manual com cron, e last_error e sobrescrito. Em 11/08 o cron morreu e
-- nada no banco registrou esse fato.

CREATE TABLE IF NOT EXISTS integration.sync_cycle_log (
  id             BIGSERIAL PRIMARY KEY,
  stream         TEXT NOT NULL,
  cycle_id       UUID NOT NULL,
  trigger_source TEXT NOT NULL,           -- 'cron' | 'manual' | 'script'
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  -- 'ok' | 'deadline' | 'timeout' | 'error' | 'lock_skipped' | 'heap_rewrite'
  -- 'deadline' (nossa parada limpa aos 45 s) e distinto de 'timeout' (o OMS nos
  -- rejeitou): confundir os dois e confundir "estamos devagar" com "fomos
  -- barrados".
  outcome        TEXT,
  tail_blocks    BIGINT NOT NULL DEFAULT 0,
  audit_blocks   BIGINT NOT NULL DEFAULT 0,
  rows_seen      BIGINT NOT NULL DEFAULT 0,
  rows_missing   BIGINT NOT NULL DEFAULT 0,
  rows_repaired  BIGINT NOT NULL DEFAULT 0,
  oms_ms         INTEGER,
  core_ms        INTEGER,
  error_message  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_cycle_log_started_at
  ON integration.sync_cycle_log (stream, started_at DESC);


-- ============================================================================
-- 3. COLUNA block_hint EM integration.sync_queue
-- ============================================================================
--
-- A varredura enfileira apenas ids (~50 bytes/linha, contra ~20 KB se levasse o
-- payload). block_hint guarda a pagina do heap do OMS onde a linha foi
-- descoberta, para que a drenagem busque os payloads em ordem FISICA.
--
-- payload_json vive no TOAST, preenchido na ordem de insercao e portanto
-- correlacionado com o ctid: buscar um lote da mesma vizinhanca de paginas
-- transforma acesso aleatorio ao heap E ao TOAST em quase sequencial.
--
-- Medido ponta a ponta contra producao: 32 -> 67 linhas/s so com a ordem
-- fisica, e 141 linhas/s combinada com lote de 2.000 (ver FETCH_BATCH_ROWS em
-- src/workers/sync/page-cursor-sync.ts).

ALTER TABLE integration.sync_queue
  ADD COLUMN IF NOT EXISTS block_hint BIGINT;

CREATE INDEX IF NOT EXISTS idx_sync_queue_fetch_block
  ON integration.sync_queue(block_hint, id)
  WHERE operation = 'FETCH';


-- ============================================================================
-- 4. CONSULTAS DE OPERACAO
-- ============================================================================

-- Progresso da volta de auditoria.
--   SELECT pass, next_block, lap_end_block,
--          round(100.0 * next_block / NULLIF(lap_end_block, 0), 1) AS pct,
--          lap_number, last_progress_at
--   FROM integration.sync_scan_cursor
--   WHERE stream = 'oms_raw_payloads';

-- O cron esta vivo?
--   SELECT max(started_at) AS ultimo_ciclo,
--          NOW() - max(started_at) AS idade
--   FROM integration.sync_cycle_log WHERE stream = 'oms_raw_payloads';

-- A ultima volta encontrou quantos buracos? (deve tender a zero em regime)
--   SELECT started_at, rows_seen, rows_missing, rows_repaired, outcome
--   FROM integration.sync_cycle_log
--   WHERE stream = 'oms_raw_payloads'
--   ORDER BY started_at DESC LIMIT 24;
