# Plano de Migracao: OMS Read-Only e Controle de Sincronizacao no CORE

Data: 2026-07-01
Atualizado: 2026-07-13
Status: Em execucao (correcao focada aplicada no codigo; governanca pendente)
Owner: Integracao/Financeiro

> **Precedencia:** este e' o plano de sync vigente. Sucede
> [PLAN-EXECUCAO-UNIFICADO-ALP-CORE-FIN.md](./PLAN-EXECUCAO-UNIFICADO-ALP-CORE-FIN.md)
> (2026-06-02), que fica mantido so como registro historico.

## Progresso (2026-07-13)
Aplicada a correcao focada que elimina a escrita tecnica em OMS no fluxo padrao:
- [x] Migration CORE `integration.sync_queue` (fila EFEMERA) e `integration.failed_jobs` com retencao
  (prisma/migrations/20260713_add_integration_sync_queue).
- [x] `CoreRepository` passa a implementar fila/lock/DLQ/infra + `purgeExpiredDeadLetters`.
- [x] `service.ts` (`runSyncOnce`) opera CORE-only por padrao; OMS apenas leitura de `raw_payloads`.
- [x] Fila EFEMERA: no sucesso a linha e removida (`markSynced` = DELETE), evitando inflar o CORE.
  A verdade de "foi sincronizado" e o proprio `mirror.raw_payloads`.
- [x] Flag `SYNC_CONTROL_TARGET` (core|oms, default core) para rollback de emergencia.
  - **Revertido em 2026-08-18: o flag e o modo `oms` foram removidos do codigo.** O rollback nunca
    teria funcionado uma vez que o read-only do OMS passou a ser aplicado de verdade (o `options` do
    libpq era ignorado pelo Supavisor; a correcao com `SET` explicito quebrou o fallback por
    completo). Mante-lo so preservava uma capacidade de escrita no OMS que nao devia existir. Junto
    com o flag sairam todos os metodos de controle do `OmsRepository`.
- [x] DLQ com `DLQ_RETENTION_DAYS` (default 90) e purga por ciclo.
- [x] Scripts (`backlog-stats`, `process-backlog`) e UI/.env.example atualizados para a fila no CORE.
- [ ] Governanca (Fase 4/6/7): migracao de historico legado para auditoria, permissao SELECT-only
  no OMS e limpeza das tabelas legadas `OMS.integration.*` (DESTRUTIVO — exige confirmacao).
  - [x] Scripts prontos (execucao manual, com gates):
    - `scripts/migrate-oms-sync-history.ts` — migra historico p/ `integration.sync_audit_log` (CORE).
      Read-only no OMS, idempotente, dry-run por padrao (`--apply` para gravar).
    - `scripts/reconcile-oms-core-sync.ts` — reconciliacao de contagens (read-only, sem gate).
    - `scripts/cleanup-oms-legacy-sync-tables.ts` — TRUNCATE/DROP das tabelas legadas no OMS.
      Exige checks de pre-requisito OK + `--apply` + env `CONFIRM_OMS_CLEANUP=CONFIRMO-LIMPEZA-OMS`.
    - `scripts/sql/oms-readonly-grant.sql` — REVOKE escrita/DDL e GRANT SELECT-only no OMS
      (aplicacao manual pelo DBA, fora do fluxo automatizado).
  - [ ] Execucao real em producao (pendente de confirmacao explicita do usuario/DBA).
- [ ] Watermark/`sync_cursor` incremental (segue como evolucao futura; fora do escopo desta rodada).

## Backlog Relacionado
- docs/BACKLOG-OMS-READONLY-CORE-CONTROLE.md

## Objetivo
Eliminar qualquer escrita tecnica em OMS. O banco OMS deve ser usado apenas para leitura da tabela `raw_payloads`. Todo o controle de status da sincronizacao (fila, retries, DLQ, lock e observabilidade) deve residir no CORE, evitando inflacao do banco local e duplicacao de registros tecnicos.

## Anti-inflacao do CORE (decisao 2026-07-13)
Mover a fila para o CORE NAO pode reproduzir a inflacao no destino. Por isso:
- A `sync_queue` e EFEMERA: contem apenas pendencias e itens em retry; no sucesso a linha e removida.
- A DLQ (`failed_jobs`) tem politica de retencao (`DLQ_RETENTION_DAYS`).
- A migracao de historico legado vai para tabela de AUDITORIA com retencao, nunca para a fila viva.

## Decisoes Confirmadas
- Lock distribuido: Postgres advisory lock no CORE.
- Alimentacao da fila: watermark no CORE por `id`, com fallback por `created_at`.
- Escopo funcional: nenhuma alteracao de regra de negocio financeira nesta etapa.

## Estado Atual (Resumo)
- Escritas tecnicas em OMS existem hoje no fluxo de sync (fila/retry/DLQ/infra).
- OMS tambem participa do lock de execucao atual.
- CORE ja persiste job lifecycle (`worker_sync_jobs`) e dados de mirror.

## Estado Alvo
- OMS: leitura somente de `raw_payloads`.
- CORE: hub unico de controle operacional da sincronizacao.
- Todo status de ciclo, pendencia, retry e falha persistido apenas no CORE.

Arquitetura alvo:
1. OMS
- Leitura exclusiva de `raw_payloads`.

2. CORE
- `integration.sync_queue` (fila de pendencias).
- `integration.failed_jobs` (DLQ).
- `integration.sync_cursor` (watermark incremental).
- `integration.sync_cycle_logs` (telemetria de ciclo).
- `integration.worker_sync_jobs` (estado de jobs).
- `mirror.raw_payloads` (destino de dados espelhados).

## Plano de Execucao

### Fase 1 - Baseline e Congelamento de Contrato
1. Inventariar todos os pontos de escrita em OMS no pipeline.
2. Coletar baseline operacional: throughput, falhas, backlog, lock_skipped, stale.
3. Definir criterios de sucesso da migracao e janela de cutover.

Entrega:
- Matriz atual de leitura/escrita por componente.
- KPI baseline para comparacao antes/depois.

### Fase 2 - Fundacao no CORE
1. Criar tabelas no CORE:
- `integration.sync_queue`
- `integration.failed_jobs`
- `integration.sync_cursor`
- `integration.sync_cycle_logs`
2. Garantir campos de rastreabilidade (`request_id`, `job_id`, `event_id`).
3. Definir indices para consumo por lote e retries (`next_retry_at`, status, created_at).

Entrega:
- Schema CORE pronto para operar sem suporte de OMS.integration.*.

### Fase 3 - Lock no CORE
1. Migrar lock de execucao para Postgres advisory lock no CORE.
2. Preservar semantica de exclusao mutua e resposta lock_skipped.
3. Registrar telemetria de tentativa/aquisicao/liberacao de lock por ciclo.

Entrega:
- Conflitos concorrentes resolvidos sem lock em OMS.

### Fase 4 - Captura Incremental sem Escrita em OMS
1. Implementar produtor de fila no CORE lendo apenas OMS.`raw_payloads`.
2. Persistir watermark no CORE por `id` e fallback por `created_at`.
3. Enfileirar somente itens novos/alterados com idempotencia.

Entrega:
- Fila no CORE abastecida sem gravar em OMS.

### Fase 5 - Refatoracao do Worker para CORE-Only Status
1. Ler pendencias exclusivamente de `integration.sync_queue` no CORE.
2. Gravar sucesso/falha/retry/DLQ apenas no CORE.
3. Remover do fluxo chamadas de escrita em OMS:
- `markProcessed`
- `markFailed`
- `moveToDeadLetter`
- bootstrap DDL em OMS (`ensureInfrastructure` para schema/tabelas tecnicas)

Entrega:
- Pipeline funcional sem escrita tecnica no OMS.

### Fase 6 - Permissoes e Hardening
1. Reduzir credencial OMS para SELECT-only em `raw_payloads`.
2. Revogar INSERT/UPDATE/DELETE/DDL no usuario tecnico de sync.
3. Validar execucao completa com perfil de acesso restrito.

Entrega:
- Garantia de governanca: OMS read-only na pratica e por permissao.

### Fase 7 - Migracao de Historico Operacional
1. Migrar historico util de `OMS.integration.sync_events` e `OMS.integration.failed_jobs` para CORE (auditoria).
2. Reconciliar contagens por status e janela temporal.
3. Definir retencao e cleanup de legado conforme compliance.

Entrega:
- Historico operacional consolidado no CORE.

### Fase 8 - Cutover e Estabilizacao
1. Ativar operacao 100% CORE para controle de sync.
2. Monitorar 3-7 dias com SLO/KPI acordados.
3. Validar ausencia de escrita em OMS via auditoria SQL e logs.
4. Remover codigo legado apos estabilidade.

Entrega:
- Cutover concluido com operacao estavel.

### Fase 9 - Documentacao e Runbook
1. Atualizar mapa operacional tecnico e executivo.
2. Publicar runbook de troubleshooting no modelo CORE-only.
3. Registrar rollback plan e criterios de acionamento.

Entrega:
- Operacao institucionalizada e auditavel.

## Criterios de Aceite
1. Usuario tecnico de sync em OMS possui apenas SELECT em `raw_payloads`.
2. Nenhuma transacao de escrita em OMS detectada durante execucoes de sync.
3. Todos os estados operacionais (`pending`, `processed`, `retry`, `dead_letter`, `lock_skipped`) atualizam somente no CORE.
4. Reprocessamento da mesma janela nao gera duplicidade (idempotencia comprovada).
5. Lock de concorrencia no CORE impede execucao paralela indevida.
6. Retry com `next_retry_at` e DLQ funcionando conforme politica definida.
7. KPI pos-cutover equivalente ou melhor ao baseline.

## Riscos e Mitigacoes
1. Lacuna de captura por watermark
- Mitigacao: fallback por `created_at`, janela de seguranca com sobreposicao, checagem de lacunas.

2. Crescimento das tabelas tecnicas no CORE
- Mitigacao: politica de retencao, particionamento e limpeza recorrente.

3. Divergencia operacional no cutover
- Mitigacao: observabilidade por ciclo, dry-run controlado, rollback objetivo.

4. Dependencia de lock em ambiente com alta concorrencia
- Mitigacao: metrica de lock contention e ajuste de cadencia/tamanho de lote.

## Rollback Plan
1. Reativar temporariamente caminho legado de controle (feature flag de emergencia).
2. Preservar dados gerados no CORE para auditoria e reconciliacao.
3. Executar reconciliacao de lacunas apos estabilizacao.
4. Retomar cutover somente com causa-raiz resolvida.

## Checklist de Implementacao
- [ ] Criar estruturas CORE de fila/retry/DLQ/cursor/log.
- [ ] Migrar lock para CORE.
- [ ] Implementar produtor incremental por watermark no CORE.
- [ ] Refatorar worker para leitura/escrita de status somente no CORE.
- [ ] Aplicar restricao de permissao OMS SELECT-only.
- [ ] Executar teste de carga e idempotencia.
- [ ] Validar KPI antes/depois.
- [ ] Atualizar mapas e runbook em docs.

## Fora de Escopo
- Mudanca de regra de negocio de reconciliacao financeira.
- Alteracoes no payload funcional de `raw_payloads`.
- Reescrita completa da arquitetura de trigger (cron continua como gatilho atual).
