-- integration.financial_orders -- tabela materializada de pedidos financeiros.
--
-- REFERENCIA, nao fonte de verdade. Quem cria a tabela em qualquer ambiente e
-- ensureFinancialOrdersTable() em
-- src/features/transactions/financial-orders-repository.ts, chamada em runtime
-- pelo job. Este arquivo existe para leitura humana e para aplicar a mao, no
-- mesmo padrao de scripts/sql/shopify-order-payment-resolution.sql.
--
-- Por que nao ha migration do Prisma: `vercel.json` roda apenas
-- `prisma generate && next build` -- nao existe `prisma migrate deploy` no
-- pipeline, entao uma migration nao chegaria a rodar em producao. (O motivo
-- alegado no plano, de que `prisma migrate` aponta para outro banco, e falso:
-- DATABASE_URL e CORE_DB_URL sao o mesmo banco em portas diferentes.)
--
-- Uma linha por PEDIDO, com o dedup de eventos ja resolvido na escrita. O
-- mirror guarda uma linha por EVENTO; e a diferenca entre as duas coisas que
-- obriga hoje cada request a varrer o mirror inteiro em memoria.

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.financial_orders (
  -- Chave do pedido. order_key = COALESCE(external_order_id, id::text), a mesma
  -- expressao que dedupeMirrorRows usa, para que "um pedido" signifique a mesma
  -- coisa nos dois caminhos.
  source                    text        NOT NULL,
  order_key                 text        NOT NULL,

  -- id do EVENTO vencedor do dedup. Vira FinancialTransaction.id na UI, que o
  -- usa como chave de lista e de navegacao -- sem ele, a materializacao nao
  -- consegue reproduzir o objeto que a tela ja recebe hoje.
  mirror_row_id             uuid,
  -- external_order_id cru, distinto de order_key: order_key cai no id quando
  -- external_order_id e nulo, e a UI precisa saber a diferenca.
  external_id               text,

  occurred_at               timestamptz NOT NULL,
  marketplace               text,
  -- Formas normalizadas para filtro, gravadas na escrita.
  -- transactionMatchesMarketplaceFilter compara contra marketplace OU source,
  -- entao os dois precisam existir como coluna indexavel.
  marketplace_key           text,
  source_key                text,
  source_bucket             text,

  order_number              text,
  description               text,
  payment_method_raw        text,
  payment_method_normalized text,

  amount_cents              bigint      NOT NULL,
  shipping_cents            bigint      NOT NULL DEFAULT 0,
  discount_cents            bigint      NOT NULL DEFAULT 0,
  tax_cents                 bigint      NOT NULL DEFAULT 0,
  fee_cents                 bigint      NOT NULL DEFAULT 0,
  liquid_cents              bigint      NOT NULL DEFAULT 0,
  currency                  text        NOT NULL DEFAULT 'BRL',

  type                      text        NOT NULL,
  tx_source                 text        NOT NULL,
  status                    text        NOT NULL,

  received_at               timestamptz,
  source_updated_at         timestamptz,

  -- description + external_id + order_number + marketplace, minusculo, unido
  -- por espaco: paridade byte a byte com o haystack de filterTransactions.
  search_text               text,

  -- Guarda de no-op do UPSERT. Deliberadamente NAO inclui received_at nem
  -- source_updated_at: incluir faria toda recarga do mirror invalidar todas as
  -- linhas materializadas, que e o oposto do que o guard existe para fazer.
  content_hash              text        NOT NULL,
  materialized_at           timestamptz NOT NULL DEFAULT NOW(),

  PRIMARY KEY (source, order_key)
);

-- Listagem e paginacao estavel. A ordem inclui a PK inteira porque occurred_at
-- empata aos milhares (pedidos no mesmo segundo) e um OFFSET sobre ordem
-- instavel repete ou pula linha entre paginas.
CREATE INDEX IF NOT EXISTS idx_financial_orders_occurred_at
  ON integration.financial_orders (occurred_at DESC, source, order_key);

-- Dois indices, nao um: o filtro de marketplace casa contra marketplace_key OU
-- source_key.
CREATE INDEX IF NOT EXISTS idx_financial_orders_marketplace_key
  ON integration.financial_orders (marketplace_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_orders_source_key
  ON integration.financial_orders (source_key, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_financial_orders_payment_method
  ON integration.financial_orders (payment_method_normalized, occurred_at DESC);

-- Busca textual. Trigram e nao tsvector de proposito: tsvector tokeniza por
-- palavra e mudaria o comportamento observavel -- "1234" deixaria de achar
-- "#12345", que e como as pessoas buscam pedido.
--
-- No Supabase as extensoes vivem no schema `extensions`, que nao esta no
-- search_path da conexao da aplicacao; por isso o opclass aparece qualificado.
-- Se a extensao nao puder ser criada, o LIKE continua funcionando sem indice
-- sobre o subconjunto ja recortado por data -- e por isso a busca nunca deve
-- ser servida sem range de data.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

CREATE INDEX IF NOT EXISTS idx_financial_orders_search_text
  ON integration.financial_orders USING gin (search_text extensions.gin_trgm_ops);

-- NENHUM indice novo e necessario em mirror.raw_payloads. Medido em 2026-08-21
-- contra a tabela real (810.637 linhas):
--   passo 1 (chaves candidatas por janela de received_at): Index Scan em
--     idx_raw_payloads_received_at -- 63.359 linhas -> 29.108 chaves em 4,1 s.
--   passo 2 (eventos das chaves): Index Scan em
--     idx_raw_payloads_external_order_id -- 500 chaves -> 2.460 eventos em 131 ms.
-- O plano pedia (source, external_order_id) e (mirror_updated_at) com
-- CONCURRENTLY; nao se justificam no modo por dia. external_order_id ja e
-- quase unico por pedido, entao acrescentar source ao indice nao muda o plano,
-- e mirror_updated_at so seria util no modo incremental por watermark, que
-- ainda nao existe. Reavaliar quando esse modo for implementado.
