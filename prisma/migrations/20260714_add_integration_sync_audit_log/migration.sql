-- Migration: tabela de auditoria para historico tecnico legado de sync (OMS)
-- Objetivo: permitir migrar o historico de OMS.integration.sync_events/failed_jobs
-- para o CORE em uma tabela SEPARADA da fila viva (integration.sync_queue),
-- evitando que a migracao de historico reintroduza inflacao no CORE.
-- Esta tabela tem finalidade de auditoria/compliance e deve ter retencao propria
-- (ver scripts/migrate-oms-sync-history.ts e politica de retencao documentada).

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.sync_audit_log (
  id BIGSERIAL PRIMARY KEY,
  source_system TEXT NOT NULL DEFAULT 'oms',
  source_table TEXT NOT NULL, -- 'sync_events' | 'failed_jobs'
  source_id BIGINT NOT NULL,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  status TEXT NOT NULL, -- 'processed' | 'dead_letter'
  retries INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  source_created_at TIMESTAMPTZ,
  source_processed_at TIMESTAMPTZ,
  migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotencia: reprocessar a migracao de historico nao duplica linhas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_audit_log_source
  ON integration.sync_audit_log(source_system, source_table, source_id);

CREATE INDEX IF NOT EXISTS idx_sync_audit_log_migrated_at
  ON integration.sync_audit_log(migrated_at);

CREATE INDEX IF NOT EXISTS idx_sync_audit_log_record
  ON integration.sync_audit_log(table_name, record_id);
