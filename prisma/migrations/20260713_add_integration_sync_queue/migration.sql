-- Migration: fila efemera e DLQ de sincronizacao no CORE (OMS read-only)
-- Objetivo: mover o controle tecnico de sync para o CORE sem inflar o banco.
-- A sync_queue e EFEMERA: linhas sao removidas ao concluir o upsert no mirror.
-- Assim a fila reflete apenas o backlog pendente/retry, nunca o historico total.

CREATE SCHEMA IF NOT EXISTS integration;

-- Fila efemera de eventos pendentes de sincronizacao.
CREATE TABLE IF NOT EXISTS integration.sync_queue (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload JSONB,
  retries INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotencia: no maximo um item pendente por (table_name, record_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_table_record
  ON integration.sync_queue(table_name, record_id);

-- Consumo por lote respeitando janela de retry.
CREATE INDEX IF NOT EXISTS idx_sync_queue_next_retry_at
  ON integration.sync_queue(next_retry_at);

-- Dead letter queue com marca temporal para politica de retencao.
CREATE TABLE IF NOT EXISTS integration.failed_jobs (
  id BIGSERIAL PRIMARY KEY,
  sync_event_id BIGINT,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload JSONB,
  retries INTEGER NOT NULL,
  error_message TEXT,
  moved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_failed_jobs_moved_at
  ON integration.failed_jobs(moved_at);

CREATE INDEX IF NOT EXISTS idx_failed_jobs_record
  ON integration.failed_jobs(table_name, record_id);
