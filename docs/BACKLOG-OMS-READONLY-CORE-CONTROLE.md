# Backlog Tecnico: OMS Read-Only e Controle no CORE

Data: 2026-07-01
Status: Pronto para execucao
Referencia de plano: docs/PLAN-OMS-READONLY-CORE-CONTROLE.md

## Convencoes
- Prioridade: P0 (critico), P1 (alto), P2 (medio)
- Estimativa: em dias uteis de engenharia
- Dependencias: ticket(s) que devem finalizar antes
- Definicao de pronto: criterio minimo para fechar ticket

## Tickets

### Fase 1 - Baseline e Contrato

1. OMSCORE-001 - Inventario de escrita em OMS
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: nenhuma
- Escopo:
  - Mapear chamadas de insert/update/delete/ddl no pipeline de sync.
  - Produzir matriz leitura vs escrita por componente.
- Definicao de pronto:
  - Documento versionado em docs com mapa completo de escrita OMS.

2. OMSCORE-002 - KPI baseline pre-cutover
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-001
- Escopo:
  - Registrar throughput, backlog, erro, retry, lock_skipped, stale.
  - Definir janela de comparacao before/after.
- Definicao de pronto:
  - Baseline publicado e aprovado para servir de gate de cutover.

### Fase 2 - Fundacao CORE

3. OMSCORE-003 - Modelagem Prisma e migrations CORE sync_queue
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: OMSCORE-002
- Escopo:
  - Criar tabela integration.sync_queue no CORE.
  - Incluir status, retry, next_retry_at, chaves de idempotencia e timestamps.
  - Criar indices de consumo por lote.
- Definicao de pronto:
  - Migration aplicada em ambiente alvo e schema validado.

4. OMSCORE-004 - Modelagem Prisma e migrations CORE failed_jobs
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-003
- Escopo:
  - Criar tabela integration.failed_jobs no CORE para DLQ.
  - Definir campos de erro, retries, payload e contexto.
- Definicao de pronto:
  - DLQ persistindo e consultavel por jobId/requestId.

5. OMSCORE-005 - Cursor incremental e logs de ciclo
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: OMSCORE-003
- Escopo:
  - Criar integration.sync_cursor e integration.sync_cycle_logs no CORE.
  - Garantir rastreabilidade requestId/jobId/eventId.
- Definicao de pronto:
  - Cursor e logs gravando em execucao de teste end-to-end.

### Fase 3 - Lock no CORE

6. OMSCORE-006 - Advisory lock no CORE
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: OMSCORE-005
- Escopo:
  - Migrar lock de execucao para Postgres advisory lock no CORE.
  - Preservar lock_skipped no resumo de execucao.
- Definicao de pronto:
  - Teste concorrente comprova exclusao mutua sem lock em OMS.

### Fase 4 - Captura incremental sem escrita OMS

7. OMSCORE-007 - Produtor de fila por watermark
- Prioridade: P0
- Estimativa: 1.5 dias
- Dependencias: OMSCORE-005
- Escopo:
  - Ler apenas OMS.raw_payloads.
  - Alimentar integration.sync_queue via watermark id + fallback created_at.
  - Aplicar idempotencia para evitar duplicidade.
- Definicao de pronto:
  - Reprocesso da mesma janela nao duplica eventos na fila.

8. OMSCORE-008 - Politica de janela de seguranca watermark
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-007
- Escopo:
  - Definir sobreposicao de janela para evitar lacunas por atraso.
  - Instrumentar metrica de lacuna detectada.
- Definicao de pronto:
  - Politica documentada e validada em simulado com dados fora de ordem.

### Fase 5 - Worker CORE-only status

9. OMSCORE-009 - Refatorar repositorio de status para CORE
- Prioridade: P0
- Estimativa: 1.5 dias
- Dependencias: OMSCORE-004, OMSCORE-006, OMSCORE-007
- Escopo:
  - Ler pendencias da sync_queue no CORE.
  - Gravar processed/retry/dead_letter apenas no CORE.
- Definicao de pronto:
  - Nenhuma escrita em OMS durante ciclo completo de sync.

10. OMSCORE-010 - Remover escrita OMS legada do fluxo
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: OMSCORE-009
- Escopo:
  - Remover markProcessed/markFailed/moveToDeadLetter e bootstrap DDL em OMS.
  - Garantir fallback seguro por feature flag.
- Definicao de pronto:
  - Codigo legado de escrita em OMS desativado em ambiente alvo.

11. OMSCORE-011 - Ajustar scripts operacionais para CORE-only
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-009
- Escopo:
  - Atualizar scripts de trigger/list/process backlog para consultar status no CORE.
- Definicao de pronto:
  - Operacao diaria sem dependencia de OMS.integration.*.

### Fase 6 - Hardening de permissoes

12. OMSCORE-012 - Grant OMS SELECT-only
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-010
- Escopo:
  - Revogar write/ddl do usuario de sync em OMS.
  - Manter somente SELECT em raw_payloads.
- Definicao de pronto:
  - Auditoria SQL comprova ausencia de privilegios de escrita.

13. OMSCORE-013 - Teste de regressao com usuario restrito
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-012
- Escopo:
  - Executar sync real com credencial restrita.
  - Validar sucesso funcional e ausencia de erro de permissao indevida.
- Definicao de pronto:
  - Execucao completa aprovada com OMS read-only enforced.

### Fase 7 - Historico operacional

14. OMSCORE-014 - Migrar historico tecnico OMS para CORE
- Prioridade: P1
- Estimativa: 1 dia
- Dependencias: OMSCORE-004
- Escopo:
  - Migrar dados de OMS.integration.sync_events e OMS.integration.failed_jobs (escopo de auditoria).
  - Normalizar campos e reconciliar contagens.
- Definicao de pronto:
  - Historico relevante acessivel no CORE com consistencia validada.

### Fase 8 - Cutover e estabilizacao

15. OMSCORE-015 - Cutover controlado CORE-only
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-013, OMSCORE-014
- Escopo:
  - Ativar rota principal CORE-only para status de sync.
  - Monitorar 3-7 dias com KPI e alertas.
- Definicao de pronto:
  - Operacao estavel sem escrita OMS e sem regressao de SLA.

16. OMSCORE-016 - Limpeza de codigo legado
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-015
- Escopo:
  - Remover flags/caminhos temporarios de migracao.
  - Consolidar implementacao final.
- Definicao de pronto:
  - Codigo simplificado, sem dependencia de OMS.integration.*.

### Fase 9 - Documentacao e runbook

17. OMSCORE-017 - Atualizar mapa tecnico e resumo executivo
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-015
- Escopo:
  - Atualizar docs de arquitetura operacional para CORE-only.
- Definicao de pronto:
  - Documentacao oficial refletindo o estado final em producao.

18. OMSCORE-018 - Publicar runbook e rollback operacional
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: OMSCORE-015
- Escopo:
  - Publicar procedimento de incidente, rollback e verificacoes pos-cutover.
- Definicao de pronto:
  - Equipe operacional apta a executar resposta padrao sem dependencia tacita.

## Marcos (Milestones)
1. M1 - Fundacao pronta (OMSCORE-001 a OMSCORE-006)
2. M2 - Fluxo CORE-only funcional (OMSCORE-007 a OMSCORE-011)
3. M3 - Governanca OMS read-only ativa (OMSCORE-012 e OMSCORE-013)
4. M4 - Cutover estavel e legado removido (OMSCORE-015 e OMSCORE-016)
5. M5 - Operacao institucionalizada (OMSCORE-017 e OMSCORE-018)

## Ordem sugerida de execucao (critica)
1. OMSCORE-001
2. OMSCORE-002
3. OMSCORE-003
4. OMSCORE-004
5. OMSCORE-005
6. OMSCORE-006
7. OMSCORE-007
8. OMSCORE-009
9. OMSCORE-010
10. OMSCORE-012
11. OMSCORE-013
12. OMSCORE-015

## Esforco estimado total
- Faixa: 11 a 14 dias uteis (1 engenheiro), sem contar janela de observacao do cutover.

## Riscos de agenda
1. Dependencia de janela de deploy e permissao de banco.
2. Qualidade/ordem temporal dos dados de OMS.raw_payloads.
3. Conflitos de concorrencia em horarios de pico durante transicao.

## Gate de encerramento
- Nenhuma escrita tecnica no OMS em producao por no minimo 7 dias.
- KPI de sync igual ou melhor que baseline.
- Runbook publicado e testado em simulacao de incidente.
