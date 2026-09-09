-- DDL de referencia/auditoria para integration.job_runs.
--
-- ATENCAO: este arquivo NAO e executado automaticamente por nenhuma migration
-- ou pipeline. A fonte de verdade da criacao/evolucao desta tabela e a funcao
-- ensureJobRunsTable() em src/features/integration/job-run-repository.ts,
-- chamada em runtime (idempotente, CREATE ... IF NOT EXISTS) por withJobRun()
-- antes de abrir cada execucao.
--
-- O que e: uma linha por execucao de job de cron. Existe porque ate 08/09/2026
-- nenhum job fora do sync OMS->mirror deixava vestigio consultavel pela
-- aplicacao: logInfo/logError vao so para o stdout da Vercel.
--
-- O caso que obrigou a criar: `max(materialized_at)` em
-- integration.financial_orders NAO distingue "rodou e nada mudou" de "nao
-- rodou", porque o UPSERT tem o guard
-- `content_hash IS DISTINCT FROM EXCLUDED.content_hash` e uma passagem sem
-- novidade nao mexe na coluna. Em 08/09/2026 o passe D-1 das 11:05 BRT nao
-- escreveu nada, 6 pedidos de 07/09 (R$ 2.125,23) ficaram fora da tela o dia
-- inteiro, e a ausencia de escrita foi lida como "rodou sem novidade". Uma
-- linha aqui com result->>'written' = '0' responderia na hora.
--
-- Retencao: 90 dias, purgado probabilisticamente no fim de uma escrita em cada
-- ~100 (RETENTION_DAYS / PURGE_PROBABILITY no repositorio).
--
-- Ordem de grandeza: ~20 execucoes/dia, ~1.800 linhas na janela de retencao.
--
-- Por que fora do Prisma: mesmo motivo de shopify-order-payment-resolution.sql
-- e financial-orders.sql — a tabela vive no schema `integration`, no banco
-- CORE, fora do schema.prisma/prisma/migrations, e o deploy roda apenas
-- `prisma generate && next build`, sem `migrate deploy`.

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.job_runs (
  id            uuid PRIMARY KEY,
  -- Nome estavel do job, usado como chave de agrupamento no painel.
  -- Ver JOB_NAMES em src/features/integration/job-names.ts.
  job_name      text        NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT NOW(),
  -- NULL enquanto roda. Uma linha 'running' antiga e' sinal de invocacao morta
  -- no meio (a Vercel congela a function quando ela responde).
  finished_at   timestamptz,
  status        text        NOT NULL,  -- running | ok | failed
  -- Parametros da invocacao (ex.: {"days":"2026-09-07"}). Distingue o passe
  -- D-1 do passe D-2, que sao o mesmo job_name em horarios diferentes.
  params        jsonb,
  -- Resumo devolvido pelo job. E' aqui que mora o `written: 0` que separa
  -- "rodou e nada mudou" de "nao rodou".
  result        jsonb,
  error_message text,
  request_id    text,
  duration_ms   integer
);

-- O painel le "a ultima execucao de cada job" via DISTINCT ON (job_name).
CREATE INDEX IF NOT EXISTS idx_job_runs_name_started_at
  ON integration.job_runs (job_name, started_at DESC);
