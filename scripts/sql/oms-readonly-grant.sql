-- Hardening de permissao: OMS read-only para o usuario tecnico de sync.
--
-- ATENCAO: este script NAO e executado automaticamente pela aplicacao.
-- Deve ser revisado e aplicado manualmente por um DBA/owner do banco OMS,
-- pois altera privilegios de um usuario compartilhado em infraestrutura
-- que nao pertence a este repositorio.
--
-- Pre-requisito: rodar scripts/reconcile-oms-core-sync.ts e confirmar que
-- nao ha divergencias, e que o codigo da aplicacao ja opera com
-- SYNC_CONTROL_TARGET=core havera algum tempo (nenhuma escrita tecnica no OMS).
--
-- Ajuste <sync_user> para o nome real do usuario/role tecnico usado na
-- connection string OMS_DB_URL.

-- 1) Revoga privilegios de escrita/DDL do usuario tecnico.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM <sync_user>;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA integration FROM <sync_user>;
REVOKE CREATE ON SCHEMA public FROM <sync_user>;
REVOKE CREATE ON SCHEMA integration FROM <sync_user>;
REVOKE ALL ON SCHEMA integration FROM <sync_user>;

-- 2) Garante apenas SELECT na tabela de origem de dados.
GRANT USAGE ON SCHEMA public TO <sync_user>;
GRANT SELECT ON public.raw_payloads TO <sync_user>;

-- 3) (Opcional, apos limpeza confirmada) remover o schema tecnico legado.
-- DROP SCHEMA IF EXISTS integration CASCADE;

-- 4) Validacao apos aplicar: conectar como <sync_user> e confirmar que
--    qualquer INSERT/UPDATE/DELETE/DDL falha com "permission denied",
--    e que SELECT em public.raw_payloads funciona normalmente.
