-- PEDIDO DE INFRAESTRUTURA AO OMS -- este repositorio NAO pode executar isto.
--
-- O OMS e read-only para esta aplicacao (ver docs/BACKLOG-OMS-READONLY-CORE-CONTROLE.md e
-- scripts/sql/oms-readonly-grant.sql). Criar indice e DDL, ou seja escrita: precisa ser
-- aplicado por quem administra o Postgres do OMS.
--
-- Diagnostico completo: docs/PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md, secao
-- "CAUSA RAIZ ENCONTRADA EM 2026-08-18: falta indice no OMS".


-- ============================================================================
-- O PROBLEMA
-- ============================================================================
--
-- public.raw_payloads (2,16M linhas / 5,9 GB em 2026-08-18) nao tem indice algum
-- em received_at nem processed_at. Os tres indices existentes:
--
--   raw_payloads_pkey                   (id)
--   idx_raw_payloads_source_external    (source, external_order_id)
--   idx_raw_payloads_failed_pagination  (source, error_message, received_at DESC, id DESC)
--                                       PARCIAL: WHERE processing_status = 'failed'
--
-- O terceiro parece cobrir received_at, mas o predicado parcial o torna inutil para o
-- sync, que le linhas de qualquer processing_status.
--
-- A consulta de descoberta incremental do worker
-- (OmsRepository.findRawPayloadsAfter, em
-- src/workers/sync/repositories/oms-repository.ts) fica assim:
--
--   Parallel Seq Scan on raw_payloads  (actual time=44.297..79727.620 rows=157677 loops=2)
--     Rows Removed by Filter: 928928
--     Buffers: shared hit=12271 read=188521
--   Execution Time: 79785.928 ms
--
-- ~80 segundos para devolver 800 linhas, e o custo e da varredura -- praticamente
-- identico qualquer que seja o LIMIT.
--
-- Como o pool do worker usa statement_timeout de 30s, a descoberta estoura o timeout
-- por construcao: `Query read timeout` e o last_error do ultimo job de cron
-- (2026-08-11T19:51Z), e a razao pela qual o mirror parou de receber dados.


-- ============================================================================
-- A CORRECAO PEDIDA
-- ============================================================================
--
-- A expressao do indice tem de bater EXATAMENTE com a da consulta, incluindo o
-- `id::text`: findRawPayloadsAfter ordena por `id::text` (nao por `id`), porque uuid e
-- text ordenam diferente e o keyset precisa de ordenacao total estavel.
--
-- CONCURRENTLY para nao bloquear escrita na tabela durante a criacao. Nao pode rodar
-- dentro de transacao -- executar como comando solto.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_payloads_sync_keyset
  ON public.raw_payloads ((COALESCE(received_at, processed_at)), (id::text));

-- Se por politica do OMS um indice de expressao dupla nao for aceito, a alternativa
-- minima e um indice so na expressao de data. Ele elimina o seq scan (o filtro de
-- janela passa a usar indice); o desempate por id fica no sort, sobre um conjunto ja
-- pequeno. Menos bom, mas resolve o problema principal:
--
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_payloads_sort_at
--     ON public.raw_payloads ((COALESCE(received_at, processed_at)));


-- ============================================================================
-- VALIDACAO APOS APLICAR
-- ============================================================================
--
-- Esperado: Index Scan (ou Bitmap Index Scan) em vez de Parallel Seq Scan, e tempo de
-- execucao em milissegundos em vez de ~80 segundos.

EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM public.raw_payloads
WHERE COALESCE(received_at, processed_at) IS NOT NULL
  AND (COALESCE(received_at, processed_at), id::text) > ('2026-08-11T19:54:33Z'::timestamptz, '')
ORDER BY COALESCE(received_at, processed_at) ASC, id::text ASC
LIMIT 200;
