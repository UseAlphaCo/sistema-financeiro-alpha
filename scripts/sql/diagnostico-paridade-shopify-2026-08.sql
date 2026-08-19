-- Diagnostico de paridade Shopify — consultas de medicao (rodadas em 2026-08-18)
--
-- Resultado e interpretacao: docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md
--
-- SOMENTE LEITURA. Todas as consultas sao SELECT. As secoes 1 a 6 rodam no CORE
-- (CORE_DB_URL); a secao 7 roda no OMS (OMS_DB_URL), que e read-only por contrato —
-- ver docs/BACKLOG-OMS-READONLY-CORE-CONTROLE.md.
--
-- Preambulo obrigatorio em qualquer sessao contra o OMS (o Supavisor NAO repassa o
-- `options` do startup packet, entao o SET tem de ser explicito na mesma conexao fisica):
--
--   SET default_transaction_read_only = on;
--   SET statement_timeout = 120000;
--
-- Janela medida: 2026-08-01 a 2026-08-11, por payload.created_at em America/Bahia
-- (meia-noite local = 03:00Z). O filtro `received_at >= '2026-07-30'` existe para
-- aproveitar o indice e nao varrer a tabela inteira — nao e parte da definicao da janela.


-- =============================================================================
-- 1. Sanidade: o que da para consultar, e a que custo
-- =============================================================================

SHOW default_transaction_read_only;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'mirror' AND tablename = 'raw_payloads'
ORDER BY indexname;

-- tamanho e contagem estimada, do catalogo, sem varrer nada
SELECT c.reltuples::bigint AS linhas_estimadas,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS tamanho_total
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'mirror' AND c.relname = 'raw_payloads';

-- cobertura da tabela de resolucao de gateway (o ground truth barato desta medicao)
SELECT count(*) AS linhas,
       count(*) FILTER (WHERE dominant_gateway_raw IS NULL) AS sem_gateway,
       min(resolved_at) AS resolvido_desde,
       max(resolved_at) AS resolvido_ate,
       max(transaction_processed_at) AS max_processed_at
FROM integration.shopify_order_payment_resolution;


-- =============================================================================
-- 2. Amplificacao de evento: o fator que o dedup absorve
-- =============================================================================

SELECT date((payload_json->>'created_at')::timestamptz AT TIME ZONE 'America/Bahia') AS dia,
       count(DISTINCT external_order_id) AS pedidos,
       count(*) AS eventos,
       round(count(*)::numeric / nullif(count(DISTINCT external_order_id), 0), 2) AS eventos_por_pedido
FROM mirror.raw_payloads
WHERE source = 'shopify'
  AND payload_json IS NOT NULL
  AND external_order_id IS NOT NULL
  AND received_at >= now() - interval '40 days'
GROUP BY 1
ORDER BY 1 DESC;

-- quais event_type o mirror recebe — explica o fator acima E por que reembolso e' invisivel
SELECT event_type, count(*) AS linhas, count(DISTINCT external_order_id) AS pedidos
FROM mirror.raw_payloads
WHERE source = 'shopify'
  AND received_at >= '2026-07-30'
GROUP BY 1
ORDER BY 2 DESC;


-- =============================================================================
-- 3. Distribuicao de financial_status na linha canonica
--    A CTE `canonico` reproduz em SQL a regra do app: uma linha por pedido,
--    "pago vence recencia" (dedupeMirrorRows em src/features/transactions/read-model.ts).
-- =============================================================================

WITH canonico AS (
  SELECT DISTINCT ON (rp.external_order_id)
         rp.external_order_id,
         lower(coalesce(rp.payload_json->>'financial_status', 'sem_status')) AS financial_status,
         coalesce((rp.payload_json->>'total_price')::numeric, 0) AS total_price
  FROM mirror.raw_payloads rp
  WHERE rp.source = 'shopify'
    AND rp.payload_json IS NOT NULL
    AND rp.external_order_id IS NOT NULL
    AND rp.received_at >= '2026-07-30'
    AND (rp.payload_json->>'created_at')::timestamptz >= '2026-08-01T03:00:00Z'
    AND (rp.payload_json->>'created_at')::timestamptz <  '2026-08-12T03:00:00Z'
  ORDER BY rp.external_order_id,
           (lower(coalesce(rp.payload_json->>'financial_status','')) = 'paid') DESC,
           coalesce(rp.mirror_updated_at, rp.received_at) DESC
)
SELECT financial_status,
       count(*) AS pedidos,
       round(sum(total_price), 2) AS total_rs,
       round(100.0 * count(*) / sum(count(*)) OVER (), 2) AS pct_pedidos,
       round(100.0 * sum(total_price) / sum(sum(total_price)) OVER (), 2) AS pct_rs
FROM canonico
GROUP BY 1
ORDER BY 3 DESC;

-- reembolso escondido pelo dedup? (olha TODAS as linhas, nao so a canonica)
SELECT lower(rp.payload_json->>'financial_status') AS status_em_alguma_linha,
       count(DISTINCT rp.external_order_id) AS pedidos
FROM mirror.raw_payloads rp
WHERE rp.source = 'shopify'
  AND rp.payload_json IS NOT NULL AND rp.external_order_id IS NOT NULL
  AND rp.received_at >= '2026-07-30'
  AND (rp.payload_json->>'created_at')::timestamptz >= '2026-08-01T03:00:00Z'
  AND (rp.payload_json->>'created_at')::timestamptz <  '2026-08-12T03:00:00Z'
GROUP BY 1
ORDER BY 2 DESC;


-- =============================================================================
-- 4. Erro de rateio de split — o numero central do diagnostico
--    spr.total_amount_cents    = soma das transacoes success sale/capture/change do pedido
--    spr.dominant_amount_cents = so a parte do gateway titular
--    A diferenca e' o que o sistema hoje credita ao dominante mas pertence a outro gateway.
-- =============================================================================

WITH canonico AS (
  SELECT DISTINCT ON (rp.external_order_id)
         rp.external_order_id,
         coalesce((rp.payload_json->>'total_price')::numeric, 0) AS total_price,
         lower(coalesce(rp.payload_json->>'financial_status','')) AS financial_status
  FROM mirror.raw_payloads rp
  WHERE rp.source = 'shopify'
    AND rp.payload_json IS NOT NULL AND rp.external_order_id IS NOT NULL
    AND rp.received_at >= '2026-07-30'
    AND (rp.payload_json->>'created_at')::timestamptz >= '2026-08-01T03:00:00Z'
    AND (rp.payload_json->>'created_at')::timestamptz <  '2026-08-12T03:00:00Z'
  ORDER BY rp.external_order_id,
           (lower(coalesce(rp.payload_json->>'financial_status','')) = 'paid') DESC,
           coalesce(rp.mirror_updated_at, rp.received_at) DESC
)
SELECT count(*) AS pedidos_pagos_resolvidos,
       round(sum(c.total_price), 2) AS soma_total_price_rs,
       round(sum(spr.total_amount_cents) / 100.0, 2) AS soma_transacoes_rs,
       round(sum(spr.dominant_amount_cents) / 100.0, 2) AS soma_dominante_rs,
       round(sum(spr.total_amount_cents - spr.dominant_amount_cents) / 100.0, 2) AS rs_atribuido_ao_gateway_errado,
       round(100.0 * sum(spr.total_amount_cents - spr.dominant_amount_cents)
             / nullif(sum(spr.total_amount_cents), 0), 3) AS pct_rateio_errado,
       count(*) FILTER (WHERE spr.total_amount_cents <> spr.dominant_amount_cents) AS pedidos_split_reais
FROM canonico c
JOIN integration.shopify_order_payment_resolution spr ON spr.external_order_id = c.external_order_id
WHERE c.financial_status = 'paid' AND spr.dominant_gateway_raw IS NOT NULL;

-- o mesmo erro por gateway titular: quanto cada gateway RECEBE indevidamente.
-- LIMITACAO: `spr` guarda so o dominante, entao isto NAO diz quanto cada gateway
-- DEIXA de receber. Fechar essa direcao exige uma data de detalhe transacional.
WITH canonico AS (
  SELECT DISTINCT ON (rp.external_order_id)
         rp.external_order_id,
         lower(coalesce(rp.payload_json->>'financial_status','')) AS financial_status
  FROM mirror.raw_payloads rp
  WHERE rp.source = 'shopify'
    AND rp.payload_json IS NOT NULL AND rp.external_order_id IS NOT NULL
    AND rp.received_at >= '2026-07-30'
    AND (rp.payload_json->>'created_at')::timestamptz >= '2026-08-01T03:00:00Z'
    AND (rp.payload_json->>'created_at')::timestamptz <  '2026-08-12T03:00:00Z'
  ORDER BY rp.external_order_id,
           (lower(coalesce(rp.payload_json->>'financial_status','')) = 'paid') DESC,
           coalesce(rp.mirror_updated_at, rp.received_at) DESC
)
SELECT spr.dominant_gateway_raw AS gateway_titular,
       count(*) AS pedidos,
       round(sum(spr.total_amount_cents) / 100.0, 2) AS creditado_hoje_rs,
       round(sum(spr.dominant_amount_cents) / 100.0, 2) AS realmente_desse_gateway_rs,
       round(sum(spr.total_amount_cents - spr.dominant_amount_cents) / 100.0, 2) AS excesso_rs,
       round(100.0 * sum(spr.total_amount_cents - spr.dominant_amount_cents)
             / nullif(sum(spr.dominant_amount_cents), 0), 2) AS pct_inflacao_do_gateway
FROM canonico c
JOIN integration.shopify_order_payment_resolution spr ON spr.external_order_id = c.external_order_id
WHERE c.financial_status = 'paid' AND spr.dominant_gateway_raw IS NOT NULL
GROUP BY 1
ORDER BY 3 DESC;

-- a fonte do valor esta certa? total_price (o que o sistema usa) vs bruto real da Shopify
WITH canonico AS (
  SELECT DISTINCT ON (rp.external_order_id)
         rp.external_order_id,
         coalesce((rp.payload_json->>'total_price')::numeric, 0) AS total_price,
         lower(coalesce(rp.payload_json->>'financial_status','')) AS financial_status
  FROM mirror.raw_payloads rp
  WHERE rp.source = 'shopify'
    AND rp.payload_json IS NOT NULL AND rp.external_order_id IS NOT NULL
    AND rp.received_at >= '2026-07-30'
    AND (rp.payload_json->>'created_at')::timestamptz >= '2026-08-01T03:00:00Z'
    AND (rp.payload_json->>'created_at')::timestamptz <  '2026-08-12T03:00:00Z'
  ORDER BY rp.external_order_id,
           (lower(coalesce(rp.payload_json->>'financial_status','')) = 'paid') DESC,
           coalesce(rp.mirror_updated_at, rp.received_at) DESC
)
SELECT CASE
         WHEN abs(c.total_price * 100 - spr.total_amount_cents) <= 1 THEN 'igual'
         WHEN c.total_price * 100 > spr.total_amount_cents THEN 'total_price MAIOR (sistema infla)'
         ELSE 'total_price MENOR (sistema subestima)'
       END AS situacao,
       count(*) AS pedidos,
       round(sum(c.total_price), 2) AS soma_total_price_rs,
       round(sum(spr.total_amount_cents) / 100.0, 2) AS soma_transacoes_rs,
       round(sum(c.total_price * 100 - spr.total_amount_cents) / 100.0, 2) AS diferenca_rs
FROM canonico c
JOIN integration.shopify_order_payment_resolution spr ON spr.external_order_id = c.external_order_id
WHERE c.financial_status = 'paid' AND spr.dominant_gateway_raw IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;


-- =============================================================================
-- 5. Base de data: o sistema ja usa spr.transaction_processed_at como occurredAt,
--    entao o erro residual e' so dos pedidos SEM data de transacao resolvida.
-- =============================================================================

WITH canonico AS (
  SELECT DISTINCT ON (rp.external_order_id)
         rp.external_order_id,
         coalesce((rp.payload_json->>'total_price')::numeric, 0) AS total_price,
         lower(coalesce(rp.payload_json->>'financial_status','')) AS financial_status,
         date((rp.payload_json->>'created_at')::timestamptz AT TIME ZONE 'America/Bahia') AS dia_criacao
  FROM mirror.raw_payloads rp
  WHERE rp.source = 'shopify'
    AND rp.payload_json IS NOT NULL AND rp.external_order_id IS NOT NULL
    AND rp.received_at >= '2026-07-30'
    AND (rp.payload_json->>'created_at')::timestamptz >= '2026-08-01T03:00:00Z'
    AND (rp.payload_json->>'created_at')::timestamptz <  '2026-08-12T03:00:00Z'
  ORDER BY rp.external_order_id,
           (lower(coalesce(rp.payload_json->>'financial_status','')) = 'paid') DESC,
           coalesce(rp.mirror_updated_at, rp.received_at) DESC
), pagos AS (
  SELECT c.*,
         spr.transaction_processed_at,
         date(spr.transaction_processed_at AT TIME ZONE 'America/Bahia') AS dia_pagamento
  FROM canonico c
  LEFT JOIN integration.shopify_order_payment_resolution spr
    ON spr.external_order_id = c.external_order_id
  WHERE c.financial_status = 'paid'
)
SELECT CASE
         WHEN transaction_processed_at IS NULL THEN 'SEM data de transacao (usa created_at = risco)'
         WHEN dia_pagamento = dia_criacao THEN 'data de transacao = data de criacao'
         ELSE 'data de transacao <> criacao (sistema JA usa a de transacao, igual a Shopify)'
       END AS situacao,
       count(*) AS pedidos,
       round(sum(total_price), 2) AS total_rs,
       round(100.0 * sum(total_price) / sum(sum(total_price)) OVER (), 3) AS pct_rs
FROM pagos
GROUP BY 1
ORDER BY 3 DESC;


-- =============================================================================
-- 6. Frescor do mirror e estado do sync — como o buraco de 12-18/08 foi achado
-- =============================================================================

SELECT max(received_at) AS max_received_at,
       max(mirror_updated_at) AS max_mirror_updated_at,
       max((payload_json->>'created_at')::timestamptz) AS max_order_created_at
FROM mirror.raw_payloads
WHERE source = 'shopify';

-- pedidos por dia de received_at: onde o mirror parou de receber
SELECT date(received_at AT TIME ZONE 'America/Bahia') AS dia_recebido,
       count(*) AS linhas,
       count(DISTINCT external_order_id) AS pedidos,
       min((payload_json->>'created_at')::timestamptz) AS pedido_mais_antigo,
       max((payload_json->>'created_at')::timestamptz) AS pedido_mais_novo
FROM mirror.raw_payloads
WHERE source = 'shopify' AND received_at >= '2026-08-08'
GROUP BY 1
ORDER BY 1;

SELECT stream, sort_at, record_id, updated_at
FROM integration.sync_watermark;

SELECT created_at, mode, status, requested_by, backfill_window_days, runs,
       summary->>'phase' AS phase,
       summary->>'processed' AS processed,
       summary->>'fetched' AS fetched,
       left(coalesce(last_error, ''), 120) AS last_error
FROM integration.worker_sync_jobs
ORDER BY created_at DESC
LIMIT 10;


-- =============================================================================
-- 7. Tamanho do buraco — RODAR NO OMS (OMS_DB_URL), com o preambulo read-only
--    O corte '2026-08-11T22:54:33Z' e' a marca d'agua parada (19:54:33 em
--    America/Bahia). Ajustar ao valor real de integration.sync_watermark.sort_at.
-- =============================================================================

SELECT date(coalesce(received_at, processed_at) AT TIME ZONE 'America/Bahia') AS dia,
       count(*) AS linhas,
       count(DISTINCT external_order_id) AS pedidos
FROM public.raw_payloads
WHERE source = 'shopify'
  AND coalesce(received_at, processed_at) >= '2026-08-11T22:54:33Z'
GROUP BY 1
ORDER BY 1;

-- R$ aguardando ingestao, por financial_status
WITH canonico AS (
  SELECT DISTINCT ON (external_order_id)
         external_order_id,
         coalesce((payload_json->>'total_price')::numeric, 0) AS total_price,
         lower(coalesce(payload_json->>'financial_status','')) AS financial_status
  FROM public.raw_payloads
  WHERE source = 'shopify'
    AND external_order_id IS NOT NULL
    AND payload_json IS NOT NULL
    AND coalesce(received_at, processed_at) >= '2026-08-11T22:54:33Z'
  ORDER BY external_order_id,
           (lower(coalesce(payload_json->>'financial_status','')) = 'paid') DESC,
           received_at DESC
)
SELECT financial_status,
       count(*) AS pedidos,
       round(sum(total_price), 2) AS total_rs
FROM canonico
GROUP BY 1
ORDER BY 3 DESC;
