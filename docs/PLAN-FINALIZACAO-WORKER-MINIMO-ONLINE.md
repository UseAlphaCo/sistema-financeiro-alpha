# Plan: Finalizacao do Worker (Minimo para Online)

Data: 2026-06-03
Status: Planejado

## Objetivo
Concluir o Worker ALP-OMS -> ALP-CORE-FIN no nivel minimo para publicacao online, garantindo sincronizacao confiavel no mirror, continuidade de status apos restart e validacao funcional no sistema financeiro.

## Escopo desta rodada
- Persistir jobs de sincronizacao em banco (sem depender de memoria de processo).
- Garantir operacao mirror-first como caminho oficial de ingestao.
- Validar robustez minima (lock, retry, DLQ, backfill only-missing).
- Cobrir cenarios criticos com testes automatizados.
- Consolidar evidencias de funcionamento fim a fim.

## Fora de escopo
- Reconciliacao.
- Refatoracao ampla de UI sem impacto operacional.
- Telemetria avancada de produto fora do necessario para operacao minima.

## Criterio de pronto da rodada
1. Job iniciado permanece consultavel apos restart da aplicacao.
2. Nao existe mais caminho direto Shopify -> FinancialTransaction no app.
3. Worker executa com lock, retry e DLQ funcionando em cenarios reais de erro.
4. Backfill 30/60/90 enfileira apenas registros ausentes no mirror.
5. Fluxo Integracoes -> Worker -> mirror -> Fluxo de Caixa validado com evidencia.

## Fase 1 - Persistencia de jobs (bloqueador)
### Entregas
1. Criar estrutura tecnica para jobs (ex.: integration.worker_sync_jobs e historico resumido por ciclo).
2. Substituir store in-memory por repositorio persistente em src/features/integration/worker-sync-jobs.ts.
3. Manter contrato atual de start/status para nao quebrar UI e API.
4. Persistir: status, startedAt, finishedAt, requestedBy, requestId, maxRuns, runs, lastError, summary.

### Criterio de saida
- Consultas de status continuam funcionando apos restart de processo.

## Fase 2 - Caminho unico de ingestao
### Entregas
1. Desativar webhook Shopify direto com retorno controlado e log orientativo.
2. Confirmar que nenhum endpoint do app grava pedido diretamente em FinancialTransaction fora do pipeline Worker.
3. Confirmar que tela Integracoes usa apenas start/status do Worker.

### Criterio de saida
- Ingestao oficial no app ocorre somente via Worker/mirror.

## Fase 3 - Robustez operacional minima
### Entregas
1. Validar lock advisory em concorrencia real.
2. Validar retry com backoff e envio para DLQ no limite.
3. Validar backfill com filtro de ausentes no mirror (only-missing).
4. Registrar checkpoints minimos de execucao para troubleshooting.

### Criterio de saida
- Falhas controladas sem perda silenciosa de eventos.

## Fase 4 - Testes criticos
### Entregas
1. Testes para start/status de job.
2. Testes para runSyncOnce com sucesso, lock ocupado e falha.
3. Testes para fluxo de backfill que evita re-enfileirar ja migrado.

### Criterio de saida
- Suite de testes critica verde no CI/local.

## Fase 5 - Validacao funcional e evidencias
### Entregas
1. Executar sincronizacao retroativa via Integracoes e acompanhar polling ate completed/failed.
2. Comprovar incremento no mirror.raw_payloads.
3. Comprovar reflexo no Fluxo de Caixa com dados atualizados.
4. Rodar check local: lint, typecheck, boundaries, contracts, test, build.

### Criterio de saida
- Evidencias de ponta a ponta anexadas para decisao de publicacao.

## Ordem de execucao
1. Fase 1 (bloqueador)
2. Fase 2
3. Fase 3
4. Fase 4
5. Fase 5

## Arquivos alvo (previstos)
- src/features/integration/worker-sync-jobs.ts
- src/app/api/financial/integrations/worker/start/route.ts
- src/app/api/financial/integrations/worker/status/route.ts
- src/app/api/webhooks/shopify/route.ts
- src/workers/sync/service.ts
- src/workers/sync/repositories/oms-repository.ts
- src/workers/sync/repositories/core-repository.ts
- src/app/financeiro/integracoes/page.tsx
- src/app/financeiro/fluxo-de-caixa/page.tsx
- docs/PLAN-EXECUCAO-UNIFICADO-ALP-CORE-FIN.md

## Checklist de conclusao
- [ ] Persistencia de jobs implementada e validada apos restart.
- [ ] Webhook Shopify direto desativado com retorno/log controlados.
- [ ] Lock/retry/DLQ validados com evidencias.
- [ ] Backfill only-missing validado para 30/60/90 dias.
- [ ] Testes criticos adicionados e verdes.
- [ ] Fluxo fim a fim validado (Integracoes -> Worker -> mirror -> Fluxo de Caixa).
- [ ] Check local completo executado com sucesso.

## Riscos e mitigacoes
- Risco: regressao de status por mudanca de storage de jobs.
  - Mitigacao: manter contrato de API e adicionar testes de regressao.
- Risco: caminho legado ainda recebendo trafego externo.
  - Mitigacao: retorno controlado + log com requestId para rastreio.
- Risco: variacao de schema OMS entre ambientes.
  - Mitigacao: validacao de pre-check SQL antes do rollout.

## Registro de andamento
- 2026-06-03 - Plano criado para execucao da rodada de finalizacao do Worker no nivel minimo para online, sem inicio de implementacao neste momento.
