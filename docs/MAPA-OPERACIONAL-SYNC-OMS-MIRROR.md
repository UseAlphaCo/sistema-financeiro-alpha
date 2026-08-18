# Mapa Operacional - Sync OMS para Mirror CORE

Data de referencia: 2026-07-01

## Objetivo

Este documento consolida, em um unico mapa, o desenho operacional e as regras praticas do fluxo de sincronizacao OMS -> CORE (mirror), incluindo:
- onde os comandos rodam
- quem dispara o cron
- como o worker processa
- onde ha leitura/escrita
- como interpretar travamentos (lock, stale, timeout)

## Visao Geral (Desenho)

```mermaid
flowchart LR
  A[Terminal Local
  npx tsx / node -e] --> B[Aplicacao Next.js
  rotas internas + jobs]
  C[Cloudflare Cron Worker
  a cada 30 min] -->|HTTP GET com secret| B

  B -->|leitura + escrita tecnica| D[(OMS DB)]
  B -->|upsert/delete mirror + jobs| E[(CORE DB)]

  subgraph OMS
    D1[raw_payloads
    origem de dados]
    D2[integration.sync_events
    fila tecnica]
    D3[integration.failed_jobs
    DLQ tecnica]
  end

  subgraph CORE
    E1[mirror.raw_payloads
    destino read model]
    E2[integration.worker_sync_jobs
    estado dos jobs]
  end

  D --- D1
  D --- D2
  D --- D3
  E --- E1
  E --- E2
```

## Onde cada parte roda

1. Comandos operacionais
- Rodam no terminal local (sua maquina): node -e, npx tsx scripts/*.
- Esses comandos disparam codigo do projeto que conecta em bancos remotos.

2. Cron
- O agendamento roda no Cloudflare Worker de cron.
- O cron chama a rota interna da aplicacao via HTTP autenticado.

3. Processamento de sync
- Roda no backend da aplicacao (Node runtime), nao dentro do Cloudflare.
- O backend fala com OMS e CORE via conexao de banco.

## Fluxo detalhado de execucao

```mermaid
sequenceDiagram
  participant U as Usuario (terminal local)
  participant C as Cloudflare Cron
  participant API as Next API /internal/cron/worker-sync
  participant JOB as worker-sync-jobs
  participant SVC as runSyncOnce
  participant OMS as OMS DB
  participant CORE as CORE DB

  C->>API: GET /api/internal/cron/worker-sync?days=30
  API->>JOB: startWorkerSyncJob(requestedBy=cloudflare-cron)
  JOB->>SVC: executeWorkerJob(loop)
  SVC->>OMS: try advisory lock (9382201)
  alt lock livre
    SVC->>OMS: ler candidatos + pending events
    SVC->>CORE: upsert/delete mirror.raw_payloads
    SVC->>OMS: mark processed / retry / DLQ
    SVC->>CORE: atualizar summary do job
  else lock ocupado
    SVC->>CORE: summary.phase = lock_skipped
  end

  U->>JOB: startWorkerSyncJob(requestedBy=cli-trigger)
  JOB-->>U: se houver running, retorna o job atual
  JOB-->>U: se nao houver running, cria novo job
```

## Contrato de leitura/escrita por banco

### OMS

Leitura:
- raw_payloads
- integration.sync_events (pending/retries)

Escrita tecnica:
- integration.sync_events (mark processed, retries, next_retry_at, error_message)
- integration.failed_jobs (dead letter)
- infraestrutura tecnica (ensureInfrastructure): schema/tabela/coluna no schema integration

Nao ha alteracao de dominio em raw_payloads pelo worker atual.

### CORE

Escrita:
- mirror.raw_payloads (upsert/delete)
- integration.worker_sync_jobs (status, runs, summary, last_error)

Leitura:
- estado de jobs
- cobertura mensal no mirror

## Estados de job e significado

```mermaid
stateDiagram-v2
  [*] --> queued
  queued --> running
  running --> backfill_enqueued
  backfill_enqueued --> processing_events
  processing_events --> completed
  processing_events --> failed
  processing_events --> lock_skipped
  lock_skipped --> completed
  failed --> [*]
  completed --> [*]
```

Interpretacao rapida:
1. lock_skipped
- outro processo ja segurava lock do OMS.
- nao significa corrupcao; significa ciclo sem processamento.

2. stale apos 120 min
- job ficou em running por tempo excedido e foi marcado como failed por protecao.

3. EAUTHTIMEOUT
- timeout de autenticacao/conexao (intermitente).
- tende a gerar retry, sem dead letter imediato.

## Diagnostico operacional (passo a passo)

1. Ver ultimos jobs no CORE
- confirmar se existe running
- checar phase, processed, fetched, last_error

2. Ver lock advisory no OMS (objid 9382201)
- se houver sessao antiga/idle segurando lock, liberar sessao

3. Decidir acao
- se cron running: aguardar ou encerrar manualmente para retomada controlada
- se sem running: iniciar CLI trigger

4. Validar progresso
- processed deve subir
- lockSkipped nao pode ser recorrente por longos periodos

5. Fechar janela
- medir cobertura mensal no mirror (maio/junho)
- medir pendencias retry no OMS

## Mapa de decisoes

```mermaid
flowchart TD
  A[Precisa sincronizar] --> B{Ha job running no CORE?}
  B -- Sim --> C{E cron?}
  C -- Sim --> D[Aguardar fim ou encerrar manualmente para retomada]
  C -- Nao --> E[Investigar travamento e last_error]
  B -- Nao --> F[Disparar trigger-backfill]

  F --> G{processed cresce?}
  G -- Sim --> H[Prosseguir ate completed]
  G -- Nao --> I[Checar lock OMS + EAUTHTIMEOUT]

  H --> J[Validar cobertura mensal no mirror]
  J --> K[Retomar prova final de reconciliacao]
```

## Fronteira de seguranca (regra OMS)

Atualizacao 2026-07-13: implementado no codigo. O fluxo padrao (`SYNC_CONTROL_TARGET=core`)
nao escreve mais no OMS:
1. Removida a escrita tecnica no OMS (fila/retry/DLQ/infra) do caminho padrao.
2. Fila/retry/DLQ e lock agora vivem no CORE (`integration.sync_queue`, `integration.failed_jobs`).
3. OMS permanece apenas como fonte de leitura de `raw_payloads`.

A `sync_queue` no CORE e EFEMERA (linha removida no sucesso) e a DLQ tem retencao
(`DLQ_RETENTION_DAYS`), garantindo que o CORE nao infle.

Atualizacao 2026-08-18: o fallback `SYNC_CONTROL_TARGET=oms` foi **removido do codigo**, nao so
desativado por default. `WorkerEnv` nao tem mais esse campo, e `OmsRepository` nao tem mais nenhum
metodo de escrita/controle (`ensureInfrastructure`, locks, fila, retry, DLQ) — so os dois metodos de
leitura de `raw_payloads`. O CORE e o unico alvo de controle tecnico possivel, garantido pelo
compilador (a classe nem implementa mais a interface de controle), nao so por configuracao. Ver item
6 de "Verificacao pendente da Parte 1" em `docs/PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md`.

Pendente (governanca): permissao SELECT-only no OMS, migracao de historico legado para
auditoria e limpeza das tabelas `OMS.integration.*`.

## Referencias de implementacao

- scripts/trigger-backfill.ts
- scripts/list-jobs.ts
- scripts/process-backlog.ts
- src/features/integration/worker-sync-jobs.ts
- src/features/integration/worker-job-repository.ts
- src/workers/sync/service.ts
- src/workers/sync/repositories/oms-repository.ts
- src/workers/sync/repositories/core-repository.ts
- src/workers/sync/db.ts
- src/app/api/internal/cron/worker-sync/route.ts
- cloudflare/worker-sync-cron/src/index.ts
- cloudflare/worker-sync-cron/wrangler.jsonc
