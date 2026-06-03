-- Migration: add integration.worker_sync_jobs table for Worker job persistence
CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.worker_sync_jobs (
  id uuid PRIMARY KEY,
  mode text NOT NULL,
  estimated_scope_days int,
  status text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  requested_by text,
  request_id text,
  max_runs int,
  runs int DEFAULT 0,
  last_error text,
  summary jsonb,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_worker_sync_jobs_status ON integration.worker_sync_jobs(status);
CREATE INDEX IF NOT EXISTS idx_worker_sync_jobs_started_at ON integration.worker_sync_jobs(started_at);
