-- DDL de referencia/auditoria para integration.shopify_order_payment_gateway_split.
--
-- ATENCAO: este arquivo NAO e executado automaticamente por nenhuma migration
-- ou pipeline. A fonte de verdade da criacao/evolucao desta tabela e a funcao
-- ensureShopifyPaymentGatewaySplitTable() em
-- src/features/integration/shopify-payment-resolution-repository.ts, chamada
-- em runtime (idempotente, CREATE ... IF NOT EXISTS) pelo job
-- shopify-payment-resolution-job.ts antes de cada execucao.
--
-- O que e: rateio por gateway dos pedidos Shopify pagos, uma linha por
-- (pedido, gateway), com o valor e a contagem de transacoes daquele gateway
-- naquele pedido. integration.shopify_order_payment_resolution guarda so o
-- gateway "dominante" (maior valor) e data o pedido INTEIRO pelo processed_at
-- dele; esta tabela guarda cada perna do pagamento com a sua propria data, que
-- e como a Shopify monta o relatorio "Pagamentos brutos por gateway".
--
-- Cobre TODOS os pedidos resolvidos, nao so os com >=2 gateways. A versao
-- inicial (Fase 1 do diagnostico) so persistia splits, o que bastava para
-- corrigir a quebra por forma de pagamento; passou a cobrir o dia inteiro
-- quando o Fluxo de Caixa passou a somar pagamentos por transacao. Ordem de
-- grandeza: ~1.150 linhas/dia, ~420 mil/ano.
--
-- Ver docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md.
--
-- Por que fora do Prisma: mesmo motivo de shopify-order-payment-resolution.sql
-- (tabela vive no schema `integration`, no banco CORE, fora do
-- schema.prisma/prisma/migrations).

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.shopify_order_payment_gateway_split (
  external_order_id text NOT NULL,
  gateway_raw text NOT NULL,
  amount_cents bigint NOT NULL,
  -- Transacoes de pagamento deste gateway neste pedido (kind sale/capture/change,
  -- status success). E a metrica "Transacoes" do relatorio da Shopify, que conta
  -- eventos de pagamento e nao pedidos.
  transaction_count integer NOT NULL DEFAULT 0,
  transaction_processed_at timestamptz,
  resolved_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (external_order_id, gateway_raw)
);

ALTER TABLE integration.shopify_order_payment_gateway_split
  ADD COLUMN IF NOT EXISTS transaction_count integer NOT NULL DEFAULT 0;

-- A leitura do Fluxo de Caixa janela por esta coluna.
CREATE INDEX IF NOT EXISTS idx_shopify_gateway_split_processed_at
  ON integration.shopify_order_payment_gateway_split (transaction_processed_at);
