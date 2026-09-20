-- DDL de referencia/auditoria para
-- integration.shopify_reconciliation_divergences.
--
-- ATENCAO: este arquivo NAO e executado automaticamente por nenhuma migration
-- ou pipeline. A fonte de verdade da criacao/evolucao desta tabela e a funcao
-- ensureShopifyReconciliationTable() em
-- src/features/integration/shopify-reconciliation-repository.ts, chamada em
-- runtime (idempotente, CREATE ... IF NOT EXISTS) antes de cada rodada.
--
-- O que e: uma linha por pedido Shopify em que o total do ledger de rateio
-- (integration.shopify_order_payment_gateway_split) discorda do que o
-- tenderTransactions da Shopify reporta, depois de descartadas as pernas de
-- credito na loja (ponto cego estrutural do tender) e as entradas negativas
-- (reembolso, que o ledger tambem nao soma).
--
-- O caso que obrigou a criar: ate 20/09/2026 a verificacao diaria media esse
-- desvio e publicava so o AGREGADO -- "3 pedidos / R$ 679,69" --, descartando
-- quais eram. Sem a identidade nao havia conserto possivel, e existe uma classe
-- de pedido que nenhum mecanismo automatico alcanca: o pedido JA resolvido que
-- recebe transacao nova. O predicado de findUnresolvedShopifyOrders e
-- `spr.external_order_id IS NULL OR rp.mirror_updated_at > spr.resolved_at`, e
-- uma captura que a Shopify registra dois dias depois nao altera o payload do
-- mirror -- entao o job nunca reencontra o pedido, e o auto-align do
-- shopify-verify, que chama esse mesmo job, e no-op por construcao para ele.
-- Em 30/08/2026 foram R$ 94,97 de uma perna Appmax atrasada, fechados a mao.
--
-- Por que PK por pedido e nao por (pedido, dia): o mesmo pedido redetectado e o
-- MESMO problema, nao um novo. `occurrences` conta as redeteccoes.
--
-- Por que o status 'persistente' importa: e o pedido que ja foi corrigido e
-- voltou a divergir. Separa "captura atrasada, fechou" de defeito estrutural, e
-- e o unico funil legitimo de candidatos da Fase 5 (reembolso/liquido) do
-- diagnostico de paridade. Sem ele, uma divergencia que nunca fecha fica
-- indistinguivel de uma que fecha sozinha.
--
-- Retencao: NENHUMA, deliberadamente (ao contrario de integration.job_runs, que
-- purga a 90 dias). Sao ~3 pedidos/dia, ~1.100 linhas/ano: o historico de quais
-- pedidos ja divergiram vale mais que o espaco, e `persistente` so tem
-- significado contra o passado.
--
-- Por que fora do Prisma: mesmo motivo de shopify-order-payment-resolution.sql,
-- financial-orders.sql e job-runs.sql -- a tabela vive no schema `integration`,
-- no banco CORE, fora do schema.prisma/prisma/migrations, e o deploy roda apenas
-- `prisma generate && next build`, sem `migrate deploy`.

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.shopify_reconciliation_divergences (
  external_order_id   text PRIMARY KEY,
  -- Dia da janela em que a divergencia foi detectada (fuso da verificacao).
  day                 date        NOT NULL,
  -- Total do pedido segundo o tenderTransactions.
  tender_cents        bigint      NOT NULL,
  -- ATENCAO: as duas colunas de ledger guardam o total COMPARAVEL, isto e', sem
  -- as pernas de credito na loja -- nao o total real do pedido no ledger. E a
  -- unica leitura que faz sentido aqui: a Shopify nao emite tender transaction
  -- para credito na loja, entao incluir essas pernas de um lado so faria toda
  -- linha parecer divergente. Para o total real do pedido, consulte
  -- integration.shopify_order_payment_gateway_split.
  ledger_cents_before bigint      NOT NULL,
  -- tender - ledger. Positivo = a Shopify recebeu mais do que registramos.
  delta_cents         bigint      NOT NULL,
  -- Comparavel do ledger depois da re-resolucao. NULL enquanto nao corrigido.
  ledger_cents_after  bigint,
  -- pendente | corrigido | persistente | sem_correcao
  status              text        NOT NULL,
  -- Quantas vezes este pedido foi detectado como divergente.
  occurrences         integer     NOT NULL DEFAULT 1,
  detected_at         timestamptz NOT NULL DEFAULT NOW(),
  last_checked_at     timestamptz NOT NULL DEFAULT NOW(),
  corrected_at        timestamptz
);

-- O painel e o CLI leem "o que esta aberto, mais recente primeiro".
CREATE INDEX IF NOT EXISTS idx_shopify_reconciliation_status_day
  ON integration.shopify_reconciliation_divergences (status, day DESC);
