-- Migration: marca d'agua de descoberta incremental do sync (CORE)
-- Objetivo: o ciclo automatico deixa de rescanear uma janela fixa de dias a
-- cada execucao e passa a avancar por keyset a partir do ultimo ponto lido.
--
-- Antes: findRawPayloadCandidates filtrava received_at >= NOW() - N dias e
-- ordenava DESC com LIMIT, entao cada ciclo redescobria as mesmas linhas mais
-- recentes (288 vezes por dia com o cron em */5) e nunca alcancava lacunas
-- anteriores aos N mais recentes.
--
-- Uma linha por stream. Hoje existe apenas "oms_raw_payloads"; a coluna
-- stream deixa o mecanismo reutilizavel sem nova migration.

CREATE SCHEMA IF NOT EXISTS integration;

CREATE TABLE IF NOT EXISTS integration.sync_watermark (
  stream TEXT PRIMARY KEY,
  -- Posicao do keyset: (sort_at, record_id). sort_at e
  -- COALESCE(received_at, processed_at) na origem.
  sort_at TIMESTAMPTZ,
  record_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
