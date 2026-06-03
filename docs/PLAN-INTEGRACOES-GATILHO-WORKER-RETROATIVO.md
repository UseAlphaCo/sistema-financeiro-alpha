# Plan: Integracoes Com Gatilho Worker Retroativo

Data: 2026-06-02
Status: Planejado

## Objetivo
Migrar a tela de Integracoes para acionar exclusivamente o Worker ALP-OMS -> ALP-CORE-FIN com carga retroativa de 90 dias, em modo assincrono com status de job, removendo o caminho de sync direto Shopify e ampliando a base de validacao funcional com dados historicos do OMS.

## Escopo e decisoes aprovadas
- Janela retroativa inicial: 90 dias.
- Modo de execucao: assincrono com status de job.
- Integracoes: substituir totalmente o gatilho Shopify direto.
- Reconciliacao permanece fora de escopo.

## Steps
1. Fase 1 - Contrato de orquestracao assincrona (bloqueia fases 2 e 3)
1.1 Definir contrato de job para disparo do worker via API interna, incluindo: mode=retroactive, janela fixa inicial de 90 dias, batchSize, maxRuns, dryRun=false, requestedBy, requestId.
1.2 Definir formato de retorno imediato do gatilho: jobId, status=queued|running, startedAt, estimatedScopeDays=90.
1.3 Definir formato de consulta de status: contadores fetched/processed/failed/skipped/retried/deadLettered, progresso por ciclo e lastError.
1.4 Definir limites operacionais e protecoes: rate limit, lock de execucao unica, timeout por ciclo, maximo de loops por chamada do worker.

2. Fase 2 - Camada backend para gatilho e status (depende da Fase 1)
2.1 Criar endpoint financeiro para iniciar job retroativo do worker (substitui uso de /api/financial/integrations/shopify/sync).
2.2 Criar endpoint financeiro para consultar status do job e ultimo resumo acumulado.
2.3 Implementar servico de orquestracao que execute o worker em modo assincrono (disparo nao bloqueante) usando o fluxo ja existente de src/workers/sync/run-once.ts com loop controlado para drenar backlog.
2.4 Preservar seguranca existente com withApiSecurity (admin, financeiro) e logs sensiveis com requestId.
2.5 Garantir idempotencia operacional: se ja houver job running, nova tentativa retorna estado atual em vez de iniciar concorrencia.

3. Fase 3 - Retroativo OMS no Worker (depende da Fase 2)
3.1 Incluir capacidade de retroativo no repositorio OMS para buscar pendencias por janela temporal (90 dias) sem depender apenas de eventos recentes.
3.2 Definir estrategia de retroativo sem mutar dominio do OMS: leitura de integration.sync_events com filtro temporal e/ou insercao tecnica controlada de eventos faltantes quando aplicavel ao contrato atual.
3.3 Reusar lock advisory existente para evitar execucoes paralelas durante retroativo.
3.4 Manter tratamento de falha/retry/DLQ existente e enriquecer resumo de progresso para consumo da UI.
3.5 Registrar checkpoints de execucao (ciclos, ultimo id processado, contadores cumulativos) para permitir polling confiavel.

4. Fase 4 - Tela Integracoes (paralela com parte da Fase 3 apos API pronta)
4.1 Substituir card e texto de "Sincronizar pedidos da Shopify" por "Sincronizar retroativo ALP-OMS (Worker)".
4.2 Trocar chamada de handleSync para novo endpoint de start assincrono.
4.3 Implementar polling de status por jobId ate completed|failed|canceled, com exibicao de progresso e resumo final.
4.4 Exibir claramente que a fonte e ALP-OMS via Worker e que o escopo inicial e 90 dias.
4.5 Manter listagem de transacoes importadas apontando para read model ja em uso, para validacao imediata apos sincronizacao.

5. Fase 5 - Descomissionamento do caminho Shopify direto (depende da Fase 4)
5.1 Remover o acionamento do endpoint /api/financial/integrations/shopify/sync da UI.
5.2 Marcar endpoint de sync Shopify como legado/desativado (retorno controlado 410/400 com mensagem orientativa), sem apagar historico abruptamente.
5.3 Atualizar textos da navegacao e da tela para refletir arquitetura mirror-first via Worker.
5.4 Confirmar que nao ha mais botao/fluxo no frontend acionando Shopify direto.

6. Fase 6 - Verificacao e evidencias (depende das fases 2 a 5)
6.1 Testar disparo retroativo 90 dias e acompanhar polling ate finalizacao.
6.2 Validar incremento real no mirror.raw_payloads e reflexo em /financeiro/fluxo-de-caixa (marketplace, faturamento, descontos, taxas).
6.3 Validar contadores de status do job vs contadores do worker (processed, failed, deadLettered).
6.4 Rodar npm run typecheck e smoke de tela Integracoes + Fluxo de Caixa.
6.5 Registrar evidencias no plano unificado e no plano worker com data, comando, resultado e impacto.

## Execucao paralela sugerida
1. Pode rodar em paralelo: 4.1 e 4.4 (ajustes visuais) enquanto 3.2/3.4 sao finalizados.
2. Pode rodar em paralelo: 6.2 e 6.3 apos primeiro job completo.
3. Nao paralelizar: 2.5 com 3.3 (concorrencia/locks precisam de contrato unico).

## Relevant files
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/app/financeiro/integracoes/page.tsx
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/app/api/financial/integrations/shopify/sync/route.ts
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/app/api/financial/integrations/
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/features/integration/
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/workers/sync/run-once.ts
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/workers/sync/repositories/oms-repository.ts
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/workers/sync/types.ts
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/core/security/with-api-security.ts
- /Users/sendylago/Alpha/dev/sistema-financeiro/docs/PLAN-EXECUCAO-UNIFICADO-ALP-CORE-FIN.md
- /Users/sendylago/Alpha/dev/sistema-financeiro/docs/PLAN-WORKER-SYNC.md

## Verification
1. Disparar novo endpoint start e confirmar retorno imediato com jobId e status.
2. Consultar endpoint status ate completar e conferir progressao consistente dos contadores.
3. Verificar que a tela Integracoes nao chama mais endpoint Shopify direto.
4. Confirmar aumento de registros elegiveis no mirror e reflexo no fluxo de caixa.
5. Confirmar que apenas roles admin e financeiro executam start/status.
6. Executar npm run typecheck e smoke manual em Integracoes e Fluxo de Caixa.

## Further considerations
1. Persistencia de status do job: Opcao A (memoria de processo, rapida para MVP) / Opcao B (tabela tecnica de jobs no CORE, resiliente a restart). Recomendacao: Opcao B para ambiente produtivo.
2. Estrategia de retroativo em OMS: Opcao A (reprocessar somente pendentes existentes) / Opcao B (backfill tecnico para eventos antigos nao enfileirados). Recomendacao: iniciar com A e habilitar B se cobertura menor que o esperado.
3. Escalonamento apos validacao: evoluir janela fixa 90 dias para intervalo custom (from/to) com limites e aprovacao por role admin.
