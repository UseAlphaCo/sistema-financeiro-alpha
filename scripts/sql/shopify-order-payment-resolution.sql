-- DDL de referencia/auditoria para integration.shopify_order_payment_resolution.
--
-- ATENCAO: este arquivo NAO e executado automaticamente por nenhuma migration
-- ou pipeline. A fonte de verdade da criacao/evolucao desta tabela e a funcao
-- ensureShopifyPaymentResolutionTable() em
-- src/features/integration/shopify-payment-resolution-repository.ts, chamada
-- em runtime (idempotente, CREATE ... IF NOT EXISTS) pelo job
-- shopify-payment-resolution-job.ts antes de cada execucao.
--
-- Por que fora do Prisma: esta tabela vive no schema `integration`, no mesmo
-- banco CORE onde tambem vive o mirror `mirror.raw_payloads` (populado por
-- pipeline externo, nunca pela aplicacao). Seguindo o padrao ja adotado para
-- tabelas integration/mirror (ver docs/BACKLOG-OMS-READONLY-CORE-CONTROLE.md),
-- ela fica fora do schema.prisma/prisma/migrations para evitar que o Prisma
-- tente gerenciar ou alterar uma tabela que ja existe em producao com dados
-- reais. Este arquivo existe so para leitura/auditoria do schema atual.

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.shopify_order_payment_resolution (
  external_order_id text PRIMARY KEY,
  -- null = pedido sem nenhuma transacao de pagamento resolvivel (tentado e
  -- registrado mesmo assim, para nao reentrar no pool de nao-resolvidos a
  -- cada rodada). O read-model trata null como "cair na heuristica de
  -- payment_gateway_names".
  dominant_gateway_raw text,
  dominant_amount_cents bigint NOT NULL,
  total_amount_cents bigint NOT NULL,
  transaction_processed_at timestamptz,
  resolved_at timestamptz NOT NULL DEFAULT NOW()
);
