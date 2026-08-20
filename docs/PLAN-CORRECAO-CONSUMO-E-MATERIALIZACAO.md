# Corrigir a raiz do consumo e materializar o read model financeiro

> **Status:** em execucao. Producao congelada (commits `8b1003e` e `2620098`).
> Etapa 0 concluida (`661107c`). Parte 1 com 1.1, 1.2 e a raiz do 1.4 concluidas (`0dfd481`),
> mais o hardening de OMS read-only (`edfb908`) — **corrigido**, ver item 1 abaixo, o hardening
> original nao funcionava contra o pooler real. Pendentes: 1.3, 1.5 e a Parte 2 inteira.
>
> **Validacao contra banco real: itens 1-5 rodados. Item 1 revelou bug real e foi corrigido; itens
> 2-5 passaram limpos.** Item 6 resolvido: o fallback `SYNC_CONTROL_TARGET=oms` foi removido do
> codigo (nao redesenhado) — ver detalhe no item 6. `npm run check` passa. Ver "Verificacao
> pendente" no fim para o detalhe de cada item.
>
> **Bloqueador novo (2026-08-18):** existe um buraco de sincronizacao de 12 a 18/08 com
> **R$ 3.345.430,12 em 23.811 pedidos pagos** presentes no OMS e ausentes do mirror. Precede o
> descongelamento — ver "Pendencias operacionais fora do plano" no fim.
>
> **CAUSA RAIZ ENCONTRADA em 2026-08-18:** `public.raw_payloads` no OMS **nao tem indice em
> `received_at`/`processed_at`**, entao a consulta de descoberta do sync e um seq scan de ~80s sobre
> 2,16M linhas / 5,9 GB — acima do `statement_timeout` de 30s do pool. O `Query read timeout` de
> 11/08 nao foi um incidente isolado: o ciclo falha por construcao. Ver a secao "Causa raiz" logo
> abaixo do Contexto. **Precede §1.3 e §1.5 na prioridade**, e depende de acao de infraestrutura no
> OMS ([oms-sync-keyset-index.sql](../scripts/sql/oms-sync-keyset-index.sql)).
>
> **Escopo do buraco corrigido:** nao e so Shopify nem so 12-18/08. Sao **244.691 linhas** faltando
> na janela 01-18/08, em tres fontes — anymarket 147.060, shopify 53.631, eship 44.000 — e a lacuna
> do anymarket e **cronica**, anterior ao incidente.
>
> **Decisoes de 2026-08-18** (ver detalhe em cada secao):
> - **Descongelar depois da Parte 1**, nao depois da Parte 2 — contradicao do documento resolvida em
>   "Ordem de execucao". O descongelamento e a etapa **1c**; a etapa 8 e so o cutover do legado.
> - **Fechar o buraco pela carga em bloco de §2.4**, nao pelo ciclo incremental — mais o **Passo 1b
>   (avanco manual da marca d'agua), que passou a ser obrigatorio**, nao limpeza opcional.
> - **§1.3 = `0 * * * *`** (horario).
> - **§1.5 sai do caminho critico** — vira a etapa 9, depois de producao estavel.
> - **§1.3 = `0 * * * *` reafirmado** pelo usuario apos apresentada a folga real de 1,4x no pico.
>   Risco aceito, com controle compensatorio recomendado em §1.3 (indicador de defasagem visivel).
>
> **2026-08-20 — backup proprio de `raw_payloads` de agosto/2026 concluido** (520.939 linhas, 438 MB,
> verificado): ver "Pendencias operacionais fora do plano". Nao desbloqueia nem bloqueia nada deste
> plano; reduz a exposicao da janela que ele mais mexe.

## Contexto

O CORE FIN esta congelado em producao (paginas e `/api/internal/*` devolvendo 503). O congelamento
provou a causa: com os crons cortados, o `/api/health` foi de **4 em 6 amostras com `db=down` para
15 em 15 com `db=up`**. O consumo que derrubava o Supabase e estourava limites na Vercel vinha do
ciclo de sync, nao de trafego de usuario.

## CAUSA RAIZ ENCONTRADA EM 2026-08-18: falta indice no OMS

Isto precede e explica boa parte dos dois problemas descritos abaixo, e **nao estava diagnosticado**.

`public.raw_payloads` no OMS **nao tem indice em `received_at` nem em `processed_at`**. Os unicos
indices existentes (medidos via `pg_indexes`):

| indice | definicao |
|---|---|
| `raw_payloads_pkey` | `(id)` |
| `idx_raw_payloads_source_external` | `(source, external_order_id)` |
| `idx_raw_payloads_failed_pagination` | `(source, error_message, received_at DESC, id DESC)` **parcial: `WHERE processing_status = 'failed'`** |

O terceiro parece cobrir `received_at`, mas o predicado parcial o torna inutil para o sync, que le
linhas de qualquer `processing_status`.

Consequencia, com `EXPLAIN (ANALYZE, BUFFERS)` do keyset que `findRawPayloadsAfter` usa:

```
Parallel Seq Scan on raw_payloads  (actual time=44.297..79727.620 rows=157677 loops=2)
  Filter: ((COALESCE(received_at, processed_at) >= ...) AND (ROW(COALESCE(...), id::text) > ROW(...)))
  Rows Removed by Filter: 928928
  Buffers: shared hit=12271 read=188521
Execution Time: 79785.928 ms
```

**~80 segundos de varredura sequencial de 2,16M linhas / 5,9 GB para devolver 800 linhas.** O custo e
da varredura, entao e **praticamente identico qualquer que seja o `LIMIT`**.

### Por que isso e o incidente de 11/08

`createOmsPool` define `statement_timeout: 30_000` ([db.ts](../src/workers/sync/db.ts)). A consulta
leva ~80s. **A descoberta incremental estoura o timeout por construcao** — e `Query read timeout` e
exatamente o `last_error` do ultimo job `cloudflare-cron`, em `2026-08-11T19:51Z`.

Ou seja: o cron **nao parou**. Ele seguiu rodando e cada ciclo falhou por timeout. A marca d'agua
avancou tres vezes em 11/08 (19:46 -> 19:49 -> 19:54) porque com cache de buffer quente a consulta
as vezes fecha dentro dos 30s — o plano mostra 188 mil blocos lidos do disco contra 12 mil de cache.
E marginal, e do lado errado da margem.

### O que mais isso explica

- **A lacuna cronica do anymarket.** Medido por dia, o mirror ficava para tras mesmo com o cron
  saudavel: em 06/08 recebeu 8.895 de 22.445 linhas (60% de fora); 04/08 faltando 3.455; 05/08
  4.676; 07/08 6.204; 10/08 8.630. Extrapola para tras da janela: 31/07 com 3.660 faltando. Nao e
  consequencia do incidente — e falta de vazao cronica.
- **Por que o keyset do §1.1 nao resolveu sozinho.** Ele corrigiu a *forma* da consulta (cursor que
  caminha, sem lacuna para tras), mas nao ha indice que a sirva: continua seq scan. §1.1 e correto e
  necessario; e insuficiente enquanto o indice nao existir.

### O bloqueio: o OMS e read-only

Criar indice e DDL, ou seja escrita. **Nao podemos aplicar isto** — depende de quem administra o
OMS. O DDL de referencia, com diagnostico, alternativa minima e consulta de validacao, esta em
**[scripts/sql/oms-sync-keyset-index.sql](../scripts/sql/oms-sync-keyset-index.sql)**, junto de
[oms-readonly-grant.sql](../scripts/sql/oms-readonly-grant.sql) — ambos pedidos de infraestrutura,
nao codigo executavel por este repositorio.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_raw_payloads_sync_keyset
  ON public.raw_payloads ((COALESCE(received_at, processed_at)), (id::text));
```

A expressao tem de bater exatamente com a da consulta, `id::text` incluido — `findRawPayloadsAfter`
ordena por `id::text`, nao por `id`.

Enquanto nao existir, qualquer frequencia de cron opera com ~80s de varredura por ciclo e vazao
limitada pelo `statement_timeout`. **Isto deve subir acima de §1.3 e §1.5 na prioridade** — sem o
indice, ajustar frequencia e ajustar o consumo de um ciclo que falha.

---

Sao dois problemas distintos, e o segundo e o que trava o sistema no dia a dia:

**1. O sync desperdica trabalho.** Em [oms-repository.ts:42](../src/workers/sync/repositories/oms-repository.ts#L42)
a consulta ao OMS filtra `received_at >= NOW() - ($1 * INTERVAL '1 day')`, e
[worker-sync-jobs.ts:146-152](../src/features/integration/worker-sync-jobs.ts#L146-L152) passa
`backfillDays: 30` na primeira run de **todo** job. Com o cron em `*/5`, isso e uma varredura de
janela de 30 dias 288 vezes por dia, sempre sobre os mesmos 200 registros mais recentes
(`ORDER BY received_at DESC LIMIT 200`). Somado a `awaitCompletion: true`, que segura a function
ate o job terminar, e a pools em porta 5432 (session mode, 1:1 com conexao real do Postgres).

**2. Toda leitura da aplicacao varre `mirror.raw_payloads`.** A tabela tem **748.958 linhas e
2754 MB** (catalogo, medido em 2026-08-18 — a estimativa anterior de "~1,4M linhas" estava
errada) de **eventos** (nao pedidos) com `payload_json` de 10-30KB. A consulta em
[read-model.ts](../src/features/transactions/read-model.ts) nao tem `ORDER BY`, `LIMIT` nem
`OFFSET`: traz o payload inteiro para o Node, deduplica em JS, mapeia, filtra, ordena e pagina em
memoria. O caso pior e `/lancamentos`, que pede `source=manual` sem datas — varre a tabela inteira e
descarta 100% do resultado no fim.

Resultado esperado: sync que processa so o que mudou, e uma tabela materializada por pedido que
serve navegacao, busca e listagens — com `WHERE`, `ORDER BY` e `LIMIT` reais no banco. Producao so
volta depois da Parte 1.

**Decisoes tomadas:** materializacao **por pedido apenas** (sem tabela de rollup agregado);
atualizacao **somente diaria**; **paridade de fuso** — a materializacao reproduz exatamente os
numeros atuais, e unificar as tres convencoes de dia que convivem hoje fica como item separado.

---

# Parte 1 — Corrigir a raiz do consumo

Pre-requisito para descongelar producao. Ordem por impacto.

### 1.1 Tirar o backfill do ciclo automatico — CONCLUIDO, com correcao de rota

> **Corrigido durante a execucao.** A formulacao original ("o ciclo automatico passa a apenas
> drenar `integration.sync_queue`") **quebraria a ingestao**. O unico
> `INSERT INTO integration.sync_queue` do repositorio esta em `enqueueBackfill`
> ([core-repository.ts:100](../src/workers/sync/repositories/core-repository.ts#L100)), e ele so
> roda quando `backfillDays` esta setado. A varredura de janela **e** o unico mecanismo de ingestao:
> tirar o backfill e so drenar esvaziaria a fila para sempre. (Nota posterior: `SYNC_CONTROL_TARGET`
> e o fallback que liam `integration.sync_events` do OMS foram removidos por completo — ver item 6
> da "Verificacao pendente" — entao esse mecanismo hoje nem existe mais como opcao.)

O desperdicio nao esta em *descobrir* linhas no ciclo, e sim em **redescobrir sempre as mesmas**.
A descoberta passou a ser incremental por marca d'agua (`integration.sync_watermark` no CORE,
keyset `(sort_at, record_id)` com `sort_at = COALESCE(received_at, processed_at)`), lida por
`findRawPayloadsAfter` em ordem ASC. O backfill por janela continua existindo, agora explicito em
`backfill_window_days` do job, preenchido so pelos disparos manuais
(`POST /api/financial/integrations/worker/start` e `scripts/trigger-backfill.ts`).

A marca d'agua vive **sempre no CORE e fora de `SyncControlStore`**, de proposito: avancar o cursor
nunca pode exigir escrita no OMS.

### 1.2 Parar de segurar a function — CONCLUIDO

Das duas saidas previstas, valeu a segunda. O 202 fire-and-forget **nao serve aqui**: a function
pode ser congelada assim que responde, matando o job no meio (e a razao documentada do
`awaitCompletion: true`). Ficou `awaitCompletion` mantido + `maxDuration = 60` declarado em
[worker-sync/route.ts](../src/app/api/internal/cron/worker-sync/route.ts), em vez de herdar o
default da plataforma. Comentario desatualizado ("a cada 30 min") corrigido.

### 1.3 Reduzir a frequencia — DECIDIDO: horario (`0 * * * *`)

`*/5` era desproporcional mesmo sem o rescan. Definir a frequencia pelo volume real de pedidos ao
restaurar `triggers.crons` em [wrangler.jsonc](../cloudflare/worker-sync-cron/wrangler.jsonc).

**Decisao (2026-08-18): `0 * * * *`** — 24 invocacoes/dia, o mais barato. Decisao reafirmada pelo
usuario **depois** de apresentada a aritmetica de folga abaixo.

Vazao real por invocacao: a descoberta le 200 linhas por ciclo, mas o processamento grava no maximo
`BATCH_SIZE` = 100 eventos por ciclo. Com `maxRuns=20`, cada invocacao move **~2.000 linhas** para o
mirror.

| frequencia | capacidade/dia | folga na media (~25 mil linhas/dia) | folga no pico (33.916, em 06/08) |
|---|---|---|---|
| `0 * * * *` (escolhido) | 48.000 | 1,9x | **1,4x** |
| `*/30` | 96.000 | 3,8x | 2,8x |
| `*/15` | 192.000 | 7,7x | 5,7x |

**Riscos aceitos**, explicitados para nao virarem surpresa:
- 1,4x de folga num dia de pico. Qualquer ciclo perdido gera debito que so se paga no dia seguinte.
- O historico e de **nao** dar conta: o anymarket ficou 60% para tras em 06/08 com o cron saudavel
  (ver "Causa raiz"). A causa era a falta de indice, nao a frequencia — mas a margem escolhida
  depende de o indice do item 1a0 existir.

**Controle compensatorio recomendado, dado o 1,4x:** expor a defasagem do mirror
(`now() - max(received_at)` de `mirror.raw_payloads`, por fonte) em `/integracoes`, com alerta.
§2.3 ja prescreve algo equivalente para `max(materialized_at)`; aqui o motivo e a folga estreita —
sem indicador visivel, o atraso volta a crescer em silencio, que e exatamente como este buraco
passou uma semana sem ser notado.

**Atencao ao interagir com §2.4:** com cron horario o avanco do cursor incremental e de **200 linhas
por invocacao** (ver Passo 1b de §2.4 para o porque), praticamente empatando com a chegada de
material novo. Isso torna o avanco manual da marca d'agua apos a carga em bloco **obrigatorio** — do
contrario o incremental nunca alcanca o presente nesta frequencia.

### 1.4 Corrigir o alcance do backfill — RESOLVIDO NO CAMINHO AUTOMATICO

`findRawPayloadCandidates` ordena `DESC` com `LIMIT`, entao so enxerga os N mais recentes:
**lacunas antigas dentro da janela nunca sao alcancadas**. E por isso que existem
`scripts/backfill-mirror-window.ts` (antes `backfill-june-mirror.ts`) e `scripts/process-backlog.ts`.

O keyset ascendente do item 1.1 resolve isto para o ciclo automatico: o cursor caminha para frente
e nao deixa buraco para tras. **O backfill manual por janela continua com `DESC LIMIT`** — nao foi
alterado. Fechar lacunas historicas segue sendo trabalho do carregamento em bloco de §2.4, que e
mais direto que fazer o worker rastejar. Reavaliar se o caminho manual ainda precisa de keyset
depois que §2.4 rodar.

### 1.5 Session mode -> transaction mode (por ultimo, isolado) — DECIDIDO: depois de descongelar

**Decisao (2026-08-18): sai do caminho critico do descongelamento.** Session mode com o sync ja
corrigido nao e o que derrubava o banco — o desperdicio era a janela de 30 dias rescaneada 288x/dia,
nao o modo de pooler. Fazer a troca junto com o descongelamento misturaria duas variaveis num
momento em que precisamos saber qual delas quebrou algo. Fica como item isolado, depois de producao
estavel.

`CORE_DB_URL` e `OMS_DB_URL` usam a porta 5432. **Nao trocar para 6543 sem antes migrar o lock**:
`pg_advisory_lock`/`pg_advisory_unlock` sao escopados a sessao e quebram em transaction mode.

Correcao de referencia: o lock **nao** esta em `service.ts:12` (la fica so a constante
`WORKER_LOCK_KEY = 9382201`). As chamadas estao em **dois** lugares —
[core-repository.ts:82-93](../src/workers/sync/repositories/core-repository.ts#L82-L93) e
[oms-repository.ts:145-152](../src/workers/sync/repositories/oms-repository.ts#L145-L152). Migrar
para `pg_advisory_xact_lock` dentro de transacao primeiro.

Ponto novo a considerar junto: o pool do OMS agora abre com
`options=-c default_transaction_read_only=on` (ver [db.ts](../src/workers/sync/db.ts)). Alguns
poolers ignoram `options` em transaction mode — ao migrar para 6543, revalidar que a garantia de
read-only continua de pe.

Maior risco do conjunto — fazer sozinho, depois de tudo estavel.

---

# Parte 2 — Tabela materializada por pedido

## 2.1 Onde vive e qual o padrao

`integration.financial_orders`, no banco CORE, **fora do Prisma** — mesmo padrao de
`integration.shopify_order_payment_resolution`: migration raw SQL em
`prisma/migrations/<YYYYMMDD>_add_financial_orders/migration.sql` (`CREATE ... IF NOT EXISTS`, no
estilo de [20260713_add_integration_sync_queue](../prisma/migrations/20260713_add_integration_sync_queue/migration.sql))
**mais** uma funcao `ensureFinancialOrdersTable()` idempotente chamada em runtime pelo job. As duas
coisas sao necessarias: `prisma migrate` aponta para o banco do app, nao para o CORE.

Uma linha por **pedido** (`source`, `order_key`), com o dedup ja resolvido na escrita. Colunas
achatadas a partir do payload: `occurred_at`, `marketplace`, `marketplace_key`, `source_key`,
`source_bucket`, `order_number`, `description`, `payment_method_raw`,
`payment_method_normalized`, `amount_cents`, `shipping_cents`, `discount_cents`, `tax_cents`,
`fee_cents`, `liquid_cents`, `currency`, `type`, `tx_source`, `status`, `received_at`,
`source_updated_at`, `content_hash`, `materialized_at`.

Indices que sustentam as telas: `(occurred_at DESC, source, order_key)` para listagem e paginacao
estavel; `(marketplace_key, occurred_at DESC)` e `(source_key, occurred_at DESC)` — precisa dos
dois, porque `transactionMatchesMarketplaceFilter` compara contra marketplace **ou** source;
`(payment_method_normalized, occurred_at DESC)`; e GIN trigram sobre `search_text`.

**Busca textual**: coluna `search_text` pre-normalizada (`description + externalId + orderNumber +
marketplace`, minusculo, unido por espaco — paridade byte a byte com o haystack de
`filterTransactions`) + indice GIN `pg_trgm`. `tsvector` esta descartado: tokeniza por palavra e
mudaria o comportamento observavel (`"1234"` deixaria de achar `"#12345"`). Se `pg_trgm` nao puder
ser criada no Supabase, o `LIKE` continua funcionando sem indice sobre o subconjunto ja recortado
por data — mas a busca nunca deve ser servida sem range de data.

Os dois indices novos necessarios em `mirror.raw_payloads` (`(source, external_order_id)` e
`(mirror_updated_at)`) precisam ser criados **manualmente com `CONCURRENTLY`**, fora da migration:
migrations do Prisma rodam em transacao, onde `CONCURRENTLY` falha, e um `CREATE INDEX` normal
bloquearia escrita em 1,4M linhas.

## 2.2 A regra de negocio fica em um lugar so

O mapeamento **nao pode ser reescrito em SQL**: `resolveShopifyPaymentMethod` varre
`payment_gateway_names`, `transactions`, `note_attributes`, `note` e `tags`;
`resolveShopifyShippingCents` tem tres niveis de fallback incluindo calculo por balanco. E logica
de Node.

Extrair de [read-model.ts](../src/features/transactions/read-model.ts) para um modulo puro (sem
`pg`) `src/features/transactions/mirror-order-mapper.ts`: `isMirrorOrderPaid`, `dedupeMirrorRows`,
`mapMirrorRow` e helpers, movidos **sem alteracao de comportamento**, mais
`toMaterializedOrder(row)` e `buildSearchText`/`normalizeSearchTerm` (o mesmo par usado na escrita e
na leitura). Unificar de quebra `normalizeMarketplaceToken`, hoje duplicado em `read-model.ts:503` e
[cash-flow/service.ts:268](../src/features/cash-flow/service.ts#L268).

Durante a transicao, o caminho legado importa do mesmo modulo — nada duplicado, zero risco de drift.

## 2.3 O job diario

Rota `src/app/api/internal/cron/materialize-orders/route.ts`, copia estrutural de
[shopify-payment-resolution/route.ts](../src/app/api/internal/cron/shopify-payment-resolution/route.ts)
(`runtime = "nodejs"`, auth por `CRON_SECRET`, envelope `createApiSuccess`/`createApiError`), mais um
`case` em [worker-sync-cron/src/index.ts](../cloudflare/worker-sync-cron/src/index.ts) e a entrada
correspondente no `wrangler.jsonc` — a incluir quando os crons forem restaurados.

Roda uma vez por dia e reprocessa **D-1 e D-2** (D-2 captura o que mudou depois: reembolso,
cancelamento, resolucao tardia de gateway). Mais um sweep semanal de D-45 para reembolsos tardios.

Algoritmo, por janela de dia:
1. Selecionar as chaves candidatas: `SELECT source, COALESCE(external_order_id, id::text) AS order_key`
   com `received_at` na janela **mais 2 dias de folga** de cada lado.
2. Carregar **todos** os eventos dessas chaves (o dedup precisa do conjunto completo do pedido),
   com o mesmo `LEFT JOIN integration.shopify_order_payment_resolution` e o mesmo fallback de
   `42P01` que `queryMirrorRows` ja tem.
3. Mapear em Node: `dedupeMirrorRows` -> `toMaterializedOrder`.
4. Gravar em lotes: `INSERT ... ON CONFLICT (source, order_key) DO UPDATE ... WHERE content_hash IS
   DISTINCT FROM EXCLUDED.content_hash`. O guard de hash evita `UPDATE` no-op e preserva HOT.
5. `DELETE` das chaves candidatas que nao produziram mais linha valida — sem isso, pedido estornado
   soma para sempre.

Idempotente por construcao: rodar duas vezes e no-op. O job deve nascer **parametrizado por modo**
(`day` agora; `incremental` por watermark depois), para que aumentar a frequencia no futuro seja
configuracao, nao reescrita.

**Consequencia da escolha de rodar so diariamente:** as telas refletem os dados ate a ultima
execucao, e os presets `hoje`/`ontem` do dashboard ficam defasados durante o dia. Para que isso nao
seja silencioso, expor a defasagem (`max(materialized_at)`) na tela `/integracoes` e alertar se
passar de 26h.

## 2.4 Carga inicial: dump do OMS + materializacao da janela

**So interessam os numeros de 2026-08-01 em diante.** Isso elimina o backfill em lotes pela
aplicacao: em vez de fazer o worker rastejar a tabela inteira (748.958 linhas / 2754 MB), a janela e
transferida em bloco por SQL e depois materializada em ~11 execucoes do proprio job diario. Nao e preciso escrever nenhum script de
backfill dedicado.

### Passo 1 — garantir o mirror completo na janela

O `mirror.raw_payloads` ja deve ter esse periodo (o sync roda ha tempo com janela de 30 dias), mas
**nao da para confiar**: pela limitacao do `ORDER BY received_at DESC LIMIT` descrita em §1.4, o
backfill automatico nunca alcanca lacunas que fiquem para tras dos N mais recentes. A carga em bloco
serve justamente para fechar isso de uma vez, sem depender do worker.

**Caminho em uso (decidido em 2026-08-18): [scripts/backfill-mirror-window.ts](../scripts/backfill-mirror-window.ts).**

```bash
npx tsx scripts/backfill-mirror-window.ts 2026-08-01 2026-08-18
```

O script faz OMS -> CORE por UPSERT em lotes, **sem arquivo intermediario**, e substitui as Fases 2 e
3 de [RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md](RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md) com o mesmo
resultado: as 10 colunas batem 1:1 com o `INSERT` de
[core-repository.ts:242-282](../src/workers/sync/repositories/core-repository.ts#L242-L282), mesmo
`ON CONFLICT (id) DO UPDATE`, e `synced_at`/`mirror_updated_at` preenchidas do lado do CORE. Ele ja
conta os dois lados antes e depois (a Fase 4 do runbook) e faz throttling entre lotes.

**Por que nao o `psql \copy` que este plano prescrevia:** `psql` e `pg_dump` **nao estao instalados**
nesta maquina (so `wrangler`, mesma constatacao que o plano ja fazia sobre a CLI do Supabase), e o
disco esta a 97% de uso (16 GB livres). A janela 01-18/08 tem **448.218 linhas no OMS** — medido em
2026-08-18, e nao as ~75 mil que uma extrapolacao de Shopify sugeria, porque `public.raw_payloads`
tem **todas as fontes**, nao so Shopify. Com payload de 10-30KB por linha, um CSV dessa janela nao
cabe no disco disponivel. O script nao usa disco.

**A carga precisa levar todas as fontes, nao filtrar por Shopify.** `findRawPayloadsAfter` do worker
nao filtra `source`, entao o mirror e espelho integral de `raw_payloads`. Filtrar por Shopify aqui e
ainda assim avancar a marca d'agua (Passo 1b) faria o cursor pular por cima de linhas de outras
fontes nunca carregadas — reproduzindo o buraco silencioso que este item existe para fechar, so em
outra fonte. O script nao filtra: correto como esta.

O backup completo da Fase 1 do runbook foi **deliberadamente pulado**, com justificativa registrada
la: nao escrevemos nada no OMS, e no CORE o UPSERT e reparo de um read model derivado, nao perda de
dado.

> **Atualizacao 2026-08-20 — a lacuna de backup foi fechada, por outro caminho.** Existe agora copia
> propria de `public.raw_payloads` de agosto/2026: **520.939 linhas, 438 MB**, em
> `/Volumes/externo-ugreen/backup-oms-2026-08-20260820-1551`, verificada contra o banco. Procedimento
> e evidencias em [RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md](RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md).
> Nao muda a decisao acima (o UPSERT segue sendo reparo, nao perda) — muda a exposicao: a janela que
> este plano mais mexe passou a ter copia independente dos backups gerenciados da Supabase.

**Duas correcoes aplicadas ao script antes de usa-lo** (ele existia como `backfill-june-mirror.ts` e
foi renomeado, porque virou ferramenta geral):

1. **Garantia de read-only no OMS.** O pool era um `new Pool(...)` cru, sem `SET
   default_transaction_read_only = on`. Como o item 1 da "Verificacao pendente" provou, o Supavisor
   ignora o `options` do startup packet, entao nao havia protecao nenhuma — so o fato de o script
   conter apenas `SELECT`. Passou a usar `pool.connect()` + `SET` explicito por conexao fisica, o
   mesmo padrao de `OmsRepository.query()`.
2. **Keyset em vez de `OFFSET`.** A paginacao era `LIMIT/OFFSET` sobre `ORDER BY COALESCE(received_at,
   processed_at) ASC, id ASC`: custo O(n^2), com os ultimos lotes descartando ~74 mil linhas de
   payload por consulta. E o mesmo padrao que produziu o `Query read timeout` que derrubou o cron em
   11/08. Passou a `(COALESCE(received_at, processed_at), id::text) > (cursor)`, a mesma ordenacao
   total de `OmsRepository.findRawPayloadsAfter()` — custo constante por lote. O `id::text` (em vez
   de `id`) e deliberado: uuid e text ordenam diferente, e divergir do worker abriria lacuna na
   fronteira do lote.

**Janela decidida: `2026-08-01` em diante**, nao apenas o buraco de 12-18/08. Serve a dois
propositos: fecha o buraco **e** verifica que 01-11/08 esta realmente completo, em vez de assumir —
esse periodo e a base de toda a medicao da Fase 0 do diagnostico de paridade Shopify. O UPSERT e
idempotente, entao reescrever 01-11 nao causa dano.

**Validacao** (Fase 4 do runbook): contagem no OMS e no CORE com **exatamente o mesmo filtro**, e
amostra por `id`. Divergencia aqui invalida tudo que vem depois.

### Passo 1b — avancar a marca d'agua (OBRIGATORIO, nao e limpeza opcional)

A carga em bloco escreve em `mirror.raw_payloads` **por fora do worker**, entao
`integration.sync_watermark.sort_at` nao se move. Sem tratamento, o ciclo incremental fica preso
atras da regiao ja carregada — e a aritmetica mostra que ele **nunca sai de la**:

- `discoverIncremental` ([service.ts:73](../src/workers/sync/service.ts#L73)) le `BATCH_SIZE * 2` =
  **200 linhas por ciclo**, e avanca o cursor ate a ultima **lida** (nao enfileirada).
- Todas as 200 ja existem no mirror depois da carga, entao `queued = 0`, nao ha evento pendente,
  `cycle.fetched === 0` e o job **para no run 1** por
  [worker-sync-jobs.ts:191](../src/features/integration/worker-sync-jobs.ts#L191). O `maxRuns=20`
  nao ajuda: ele nunca chega ao run 2.
- Logo o avanco e de **200 linhas por invocacao de cron**, nao 4.000.

Com cron horario, isso e ~200 linhas/hora de avanco contra ~198 linhas/hora de chegada nova
(~2.500 pedidos/dia x 1,9 eventos/pedido). **O cursor empata com a chegada e nao alcanca o
presente** — o mirror ficaria completo no momento da carga e voltaria a atrasar em seguida, em
silencio.

Correcao, logo depois da Fase 3 do runbook e antes de religar o cron. O keyset e
`(COALESCE(received_at, processed_at), id::text)`, entao o `record_id` tem de ser o `id` do **maximo
por esse par**, nao qualquer linha do maximo `sort_at`:

```sql
-- Rodar no CORE, com o mesmo filtro de data da carga em bloco.
-- Deriva a marca d'agua do que foi efetivamente carregado no mirror.
WITH topo AS (
  SELECT COALESCE(received_at, processed_at) AS sort_at, id::text AS record_id
  FROM mirror.raw_payloads
  WHERE COALESCE(received_at, processed_at) IS NOT NULL
    AND COALESCE(received_at, processed_at) >= '2026-08-01'
  ORDER BY COALESCE(received_at, processed_at) DESC, id::text DESC
  LIMIT 1
)
INSERT INTO integration.sync_watermark (stream, sort_at, record_id, updated_at)
SELECT 'oms_raw_payloads', sort_at, record_id, NOW() FROM topo
ON CONFLICT (stream) DO UPDATE
  SET sort_at = EXCLUDED.sort_at,
      record_id = EXCLUDED.record_id,
      updated_at = NOW();
```

Nao ha risco de pular material: `discoverIncremental` recua `SYNC_WATERMARK_GRACE_SECONDS` (default
**300s**) antes de consultar, e a consulta e `>` sobre o keyset — o que entrou no OMS durante a
exportacao tem `sort_at` maior e sera alcancado no ciclo seguinte.

**Validacao:** apos religar o cron, um ciclo deve logar `sync_incremental_enqueued` com `toSortAt`
proximo de `now()`, nao de 11/08. Se vier 11/08, a marca d'agua nao foi avancada.

### Passo 2 — materializar a janela

Rodar o job de §2.3 em `mode=day` para cada data de 2026-08-01 ate D-1 — ~11 execucoes, minutos. E o
mesmo caminho de codigo que roda todo dia, entao a carga inicial exercita exatamente o que vai
operar em producao. Nada de codigo especifico de backfill para manter.

### Consequencia: piso de data no read model

A tabela materializada passa a cobrir **apenas 2026-08-01 em diante**. Sem tratamento, ao ligar a
flag qualquer consulta a periodo anterior devolveria zero silenciosamente — e a UI tem presets d30,
d60 e d90, alem da comparacao com o periodo anterior, que atravessam esse piso.

Tratamento: constante `MATERIALIZED_FLOOR_DATE = '2026-08-01'`; se o periodo pedido comeca antes
dela, a consulta **cai no caminho legado** em vez de mentir. Como consulta a periodo antigo e rara,
o custo fica contido. Para empurrar o piso para tras depois, e o mesmo procedimento deste item com
outra janela de datas — e so quando o piso alcancar o inicio do historico e que o caminho legado
pode ser removido (etapa 8).

## 2.5 Reapontar a leitura

`read-model.ts` vira **fachada**; o SQL vive em
`src/features/transactions/materialized-orders-repository.ts`. As tres funcoes publicas
(`listFinancialReadModelTransactions`, `listFinancialReadModelPaginated`,
`listMarketplaceReadModelPaginated`) mantem assinatura — nenhum consumidor muda.

A query de listagem faz `WHERE` por periodo, marketplace, forma de pagamento, status e busca;
`ORDER BY occurred_at DESC, source, order_key`; `LIMIT/OFFSET` reais; e `count(*) OVER ()` para
trazer o `total` no mesmo round trip. O desempate no `ORDER BY` corrige um bug latente: hoje o
`slice` sobre um `Map` tem ordem indefinida entre empates de `occurredAt`, o que pode duplicar ou
omitir itens entre paginas.

`listFinancialReadModelPaginated` continua unindo CORE + Prisma (`manual`/`import`, possivelmente em
bancos distintos, entao merge em Node). Buscar no maximo `offset + limit` de cada lado — e exato, e
ja corrige o `findMany` sem `take` de hoje.

**Curto-circuito** (pode ir sozinho, antes de tudo, como quick win): se os filtros provam que a
tabela nao tem o que contribuir (`type !== 'income'`, `categoryId` presente, `source`/`sources` sem
`integration`/`webhook`), retornar vazio sem tocar o banco. So isso ja mata a varredura completa que
`/lancamentos` dispara hoje.

## 2.6 `computeCashFlow` em SQL

[cash-flow/service.ts:410-465](../src/features/cash-flow/service.ts#L410-L465) hoje chama o read
model duas vezes em sequencia (periodo atual e anterior — sequencial de proposito, porque o pool
`max: 2` nao aguentava `Promise.all`) e agrega em JS. Passa a ser **uma query com `GROUP BY`**
cobrindo os dois periodos via `WITH ranges(period, start_at, end_at) AS (VALUES ...)`. O `GROUP BY`
de [aggregateTransactions](../src/features/cash-flow/service.ts#L82-L92) ja e o molde exato.

Paridade a preservar, sob pena de mudar numeros silenciosamente:
- **Nao filtrar `status`** — o caminho mirror atual nao filtra, e linhas `rejected` somam hoje.
  Manter e documentar; mudar isso e decisao de produto.
- `source_bucket` materializado como `marketplace ?? externalSource ?? source`, igual a
  `summarizeTransactions` — e **nao** como o `COALESCE(NULLIF(marketplace,''), source)` do SQL
  legado, que ignora `externalSource`.
- `totalTaxCents` do resumo e `tax + fee`.
- `bySource.transactionCount` conta income e expense; `byPaymentMethod` conta so income.
- **`bigint` volta como string no driver `pg`** — converter com o `toNumber` que ja existe
  ([service.ts:165](../src/features/cash-flow/service.ts#L165)). Somar strings e o bug mais provavel
  desta etapa.

## 2.7 Corte seguro

Flag `isMaterializedReadModelEnabled()` em
[read-model-config.ts](../src/shared/read-model-config.ts), no mesmo estilo de
`isMirrorReadModelEnabled()`, default desligado, ligada por env sem deploy. Enquanto ela existir, o
caminho legado permanece intacto.

`scripts/compare-read-model.ts` roda os dois caminhos sobre uma matriz de filtros (presets x
marketplaces x formas de pagamento x termos de busca) e reporta diferenca de `total`, de soma de
`amountCents` e o set diff por `externalId`. Criterio de corte: zero divergencia em 30 dias.

Ground truth externa: `npm run verify:shopify` ja compara contra a API real da Shopify — rodar para
D-1 e alguns dias historicos depois de ligar a flag. Rollback e desligar a env.

---

## Ordem de execucao

**Contradicao resolvida (2026-08-18):** o Contexto dizia "producao so volta depois da Parte 1" e esta
tabela punha "descongelar" na etapa 8, depois da Parte 2 inteira. **Vale o Contexto:** o
congelamento provou que o consumo vinha do ciclo de sync, nao de trafego de usuario, e §1.1/§1.2 ja
corrigiram isso. A Parte 2 e protecao para escala, nao pre-requisito. O descongelamento e a etapa 1c
abaixo; a etapa 8 trata apenas do cutover do caminho legado.

| # | Etapa | Verificacao |
|---|---|---|
| 0 | ~~Curto-circuito do `/lancamentos` (§2.5)~~ **feito** (`661107c`) | Unit com `pg` mockado: `pool.query` nao e chamado para `{source:"manual"}`, `categoryId`, `type!=income` nem `sources` disjunto — mais 3 controles provando que o caminho normal ainda consulta |
| 1 | ~~§1.1, §1.2, raiz do §1.4~~ **feito** (`0dfd481`, `edfb908`); falta §1.3 (§1.5 saiu do caminho critico) | `npm run check` verde. **Validado contra banco real, itens 1-5** — ver "Verificacao pendente" |
| **1a0** | **PEDIR O INDICE NO OMS** ([oms-sync-keyset-index.sql](../scripts/sql/oms-sync-keyset-index.sql)) — acao de infraestrutura, fora deste repo | `EXPLAIN` da consulta de descoberta mostra Index Scan e tempo em ms, nao Parallel Seq Scan de ~80s. **Precede tudo:** sem isso o ciclo de sync falha por `statement_timeout` |
| 1a | **Fechar o buraco de 01-18/08** pela carga em bloco de §2.4 Passo 1 + **Passo 1b (marca d'agua)** | Contagem OMS vs CORE com o mesmo filtro, **por fonte** (a lacuna e de 244.691 linhas em anymarket/eship/shopify, nao so Shopify); e a marca d'agua avancada para perto de `now()`, nao 11/08 |
| 1b | **§1.3** (`0 * * * *`) + `wrangler deploy` do worker | `triggers.crons` restaurado no arquivo **e** no Cloudflare; um ciclo loga `sync_incremental_enqueued` com `toSortAt` proximo de `now()` |
| 1c | **Descongelar producao** (`MAINTENANCE_MODE`) | `/api/health` com `db=up` em 15 de 15 amostras **com os crons religados** — a mesma medicao que provou o diagnostico. Rollback e religar o gate |
| 2 | Extrair `mirror-order-mapper.ts` (§2.2) | Vitest sem banco: pago/nao pago, dedup "pago vence recencia", `amountCents<=0`, gateway via `spr` vs heuristica, `search_text` identico ao haystack atual |
| 3 | Migration + `ensureFinancialOrdersTable` + upsert (§2.1) | Teste de integracao no padrao de [worker-job-repository.test.ts](../src/features/integration/worker-job-repository.test.ts) (skip sem `CORE_DB_URL`): ensure 2x idempotente, upsert com mesmo hash nao muda `materialized_at` |
| 4 | Job diario + rota de cron (§2.3) | `curl` autenticado na rota para um dia; comparar `count(*)`/`sum(amount_cents)` contra o `/fluxo-de-caixa` do mesmo dia |
| 5 | Materializacao da janela (§2.4 Passo 2) — a carga do mirror ja aconteceu na etapa 1a | Contagem por dia vs pedidos distintos no mirror — a diferenca deve ser so os nao pagos, quantificada |
| 6 | Leitura atras da flag + piso de data (§2.5, §2.4) | `compare-read-model.ts` zerado de 2026-08-01 em diante; periodo anterior ao piso cai no legado, nao em zero; paginacao paginas 1 e 2 sem sobreposicao |
| 7 | `computeCashFlow` em SQL (§2.6) | Teste puro do fold; `verify:shopify` para D-1 |
| 8 | Cutover: remover caminho legado, flag e `RECEIVED_AT_GRACE_MS` | So depois de o piso alcancar o inicio do historico. `npm run check`. **Nao envolve descongelar** — isso ja aconteceu na etapa 1c |
| 9 | §1.5 (session -> transaction mode), isolado | Ver §1.5. Maior risco do conjunto; revalidar o read-only do OMS contra o pooler novo |

## Verificacao end-to-end

Ambiente local com Postgres em Docker e pre-requisito pratico para as etapas 3-7 (hoje nao existe
`docker-compose` no repo, e o schema `mirror` **nao tem DDL versionado** — precisa ser extraido do
Supabase com `pg_dump --schema-only --schema=mirror` e versionado junto, senao nenhum ambiente pode
ser criado do zero).

Pronto quando: `/fluxo-de-caixa` e `/lancamentos` respondem sem varrer `raw_payloads`
(confirmavel por `pg_stat_statements` ou pelo tempo de resposta), `compare-read-model.ts` reporta
zero divergencia de 2026-08-01 em diante, `verify:shopify` bate para D-1, e o `/api/health` se
mantem `db=up` com os crons religados — a mesma medicao que provou o diagnostico.

---

## Verificacao pendente da Parte 1

Sao pre-requisitos para descongelar producao. Itens 1-5 rodados contra banco real; item 6 resolvido
por remocao de codigo.

1. **`options` do libpq contra o pooler real do OMS — RODADO, ERA UM BUG REAL, CORRIGIDO.**
   Conectando com `createOmsPool` contra a `OMS_DB_URL` real (Supavisor, sessao em
   `aws-*.pooler.supabase.com:5432`): `SHOW default_transaction_read_only` voltou **`off`**, e um
   `UPDATE` de teste (com `WHERE` sobre um UUID garantidamente inexistente, para ser seguro mesmo se
   a garantia falhasse) **nao foi rejeitado**. Diagnostico: o Supavisor **nao repassa o `options` do
   startup packet** ao backend real — confirmado tambem por `application_name` chegar sobrescrito
   como `"Supavisor"` em vez do valor pedido pelo client. O `options: "-c
   default_transaction_read_only=on"` do Pool ([db.ts](../src/workers/sync/db.ts)) nunca protegeu
   nada contra esse pooler, em nenhuma porta — nao e um risco exclusivo da futura migracao para 6543
   (item 1.5), ja estava quebrado em 5432.

   **Correcao aplicada** em
   [oms-repository.ts](../src/workers/sync/repositories/oms-repository.ts): todo metodo da classe
   passou a rodar via `pool.connect()` + `SET default_transaction_read_only = on` explicito, na
   mesma conexao fisica, antes de qualquer outra instrucao — em vez de confiar no `options` do
   startup packet (que fica como defesa em profundidade, nao faz mal manter). Validado contra o OMS
   real: apos o `SET` explicito, o mesmo `UPDATE` de teste falhou com "cannot execute UPDATE in a
   read-only transaction". Coberto por teste unitario com `pg` mockado em
   [oms-repository.test.ts](../src/workers/sync/repositories/oms-repository.test.ts) (prova a ordem
   das chamadas e que o client e sempre liberado, inclusive em erro) — nao repete a escrita contra o
   OMS real; `npm run check` passa (53 testes, build, lint, typecheck, boundaries, contracts).

   **Nota lateral (superada):** os metodos de fallback (`acquireExecutionLock`/`releaseExecutionLock`/
   etc., usados apenas quando `SYNC_CONTROL_TARGET=oms`) pegavam uma conexao fisica nova a cada
   chamada, entao um lock adquirido numa chamada nao seria liberavel pela mesma sessao numa chamada
   seguinte. Deixou de ser relevante: esses metodos foram removidos por completo do
   `OmsRepository` (ver item 6) em vez de corrigidos, ja que o caminho inteiro era descartavel.

2. **Inicializacao da marca d'agua — RODADO, OK.** `npm run worker:sync:once` logou
   `sync_watermark_initialized` com `derivedFrom: "mirror_max"` (`sortAt: 2026-08-11T19:46:00.848Z`,
   nao `epoch`). Apos o ciclo, `SELECT ... FROM integration.sync_watermark WHERE stream =
   'oms_raw_payloads'` confirmou `sort_at` avancado para `2026-08-11T19:49:56.022Z`, batendo com o
   `toSortAt` do `sync_incremental_enqueued` do mesmo ciclo — a marca d'agua avanca de verdade a
   cada ciclo.
3. **Um ciclo automatico nao dispara backfill — RODADO, OK.** No mesmo log do item 2:
   `sync_started` com `discoveryMode: "incremental"`, `batch_processed`/`sync_completed` com 86
   processados e 0 falhas, e nenhum `sync_backfill_enqueued` no run inteiro.
4. **Um disparo manual ainda dispara — RODADO, OK (com uma flakiness anotada abaixo).**
   `npx tsx scripts/trigger-backfill.ts 30 1` logou `sync_started` com `discoveryMode: "window"`,
   `backfillDays: 30`, seguido de `sync_backfill_enqueued` com `days: 30, candidates: 200, missing:
   200, queued: 200`.

   Na primeira tentativa o job falhou antes de chegar a enfileirar: `last_error: "Connection
   terminated due to connection timeout"` (erro do `pg-pool` ao abrir uma conexao fisica nova com o
   OMS, estourando `connectionTimeoutMillis: 10_000`; ver [db.ts](../src/workers/sync/db.ts)) — nao
   e uma regressao do fix do item 1 (o padrao de conexao-por-query e o mesmo de antes, e
   `pool.query()` tambem abre/fecha conexao internamente), pareceu hiccup transitorio do Supavisor.
   A segunda tentativa, alguns segundos depois, passou limpo. Vale observar se volta a acontecer com
   frequencia — se sim, o worker precisa de retry em `startWorkerSyncJob`/`executeWorkerJob`, que
   hoje nao tem.
5. **A coluna nova entra em tabela existente — RODADO, OK.** O job do item 4 terminou com `status:
   "completed"`, `runs: 1`, `backfill_window_days: 30`, `last_error: null`, `summary.processed: 100`
   — confirma que `ALTER TABLE integration.worker_sync_jobs ADD COLUMN IF NOT EXISTS
   backfill_window_days` aplicou sem erro contra a tabela ja existente em producao.
6. **`SYNC_CONTROL_TARGET=oms` — RESOLVIDO POR REMOCAO, nao redesenho.** Estava estruturalmente
   quebrado desde a correcao do item 1 (`ensureInfrastructure()` do `OmsRepository` falharia com
   "read-only transaction" na primeira chamada). Em vez de deixar o flag existir como codigo morto
   atras de um default seguro, a capacidade foi eliminada em camadas que se reforcam:
   - `SYNC_CONTROL_TARGET` deixou de existir em `WorkerEnv` ([config.ts](../src/workers/sync/config.ts))
     — nao ha mais como selecionar "oms", nem por engano de configuracao.
   - `OmsRepository` perdeu todos os metodos de controle (`ensureInfrastructure`,
     `acquireExecutionLock`, `releaseExecutionLock`, `enqueueBackfill`, `findPendingEvents`,
     `markSynced`, `markFailed`, `moveToDeadLetter`) e o `implements SyncControlStore`
     ([oms-repository.ts](../src/workers/sync/repositories/oms-repository.ts)) — sobram so os dois
     metodos de leitura. Nenhum codigo futuro consegue voltar a usar essa classe como armazenamento
     de controle sem reescrever a capacidade do zero: a garantia agora e do compilador, nao so do
     Postgres em runtime.
   - `service.ts` passou a usar `coreRepository` incondicionalmente como `controlStore`, sem
     ramificacao.

   Complementar (fora do codigo desta aplicacao, acao manual de DBA): `scripts/sql/oms-readonly-grant.sql`
   ja existe para revogar `INSERT/UPDATE/DELETE/TRUNCATE/CREATE` do usuario tecnico no Postgres do
   OMS — isso mata a escrita tambem no nivel de permissao do banco, mais forte que qualquer guard em
   codigo. Nao foi executado aqui; e uma acao de infraestrutura que so quem administra o OMS pode
   aplicar.

## Pendencias operacionais fora do plano

- **CONCLUIDO 2026-08-20 — backup proprio de `public.raw_payloads` de agosto/2026.** 520.939 linhas,
  438 MB, em fatias semanais `.csv.gz` no disco externo, com `SHA256SUMS.txt`; conferido contra o
  banco (as duas semanas fechadas bateram exato). Ver
  [RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md](RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md), que traz tambem tres
  achados reaproveitaveis por qualquer trabalho contra o OMS: o **pooler descarta `PGOPTIONS`** (so
  `SET` por `-c` pega), o **`statement_timeout` do papel `postgres` e 2 min**, e **nao ha indice em
  `received_at`** — o que reconfirma a "Causa raiz" deste plano por um caminho independente.
  **Cobertura: 01/08 ate ~17:33 de 20/08.** Fechar o mes exige reexecutar depois de 01/09 apagando as
  fatias da cauda — a retomada do loop nao as atualiza sozinha.

- **BURACO DE SINCRONIZACAO — 244.691 linhas faltando no mirror na janela 01-18/08, das quais
  R$ 3.345.430,12 em 23.811 pedidos pagos Shopify de 12 a 18/08.** Medido em 2026-08-18 (ver
  [DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md](DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md), secao "Achado
  operacional"; consultas em
  [scripts/sql/diagnostico-paridade-shopify-2026-08.sql](../scripts/sql/diagnostico-paridade-shopify-2026-08.sql)
  secao 7). Sao 79% do faturamento dos 11 dias anteriores, ausentes do sistema.

  **Lacuna por fonte:** anymarket 147.060 · shopify 53.631 · eship 44.000. A do anymarket e
  **cronica** — em 06/08, com o cron saudavel, o mirror recebeu 8.895 de 22.445 linhas; o padrao se
  repete em 04, 05, 07 e 10/08 e vaza para 31/07. Nao e consequencia do incidente de 11/08, e a
  causa e a falta de indice no OMS (ver "Causa raiz").

  Mecanismo, confirmado:
  1. O cron parou de produzir efeito em `2026-08-11T19:51Z` com `Query read timeout` (ultimo job
     `cloudflare-cron` em `integration.worker_sync_jobs`). **Nao foi um incidente isolado:** sem
     indice em `received_at`/`processed_at`, a consulta de descoberta leva ~80s contra um
     `statement_timeout` de 30s — falha por construcao, e so passava com cache quente.
  2. `integration.sync_watermark.sort_at` **nao pulou** — segue em `2026-08-11T19:54:33Z`. O buraco
     e' **recuperavel**: o keyset ascendente do item 1.1 retoma de 11/08 e caminha para frente.
  3. Um `cli-trigger` com `backfill_window_days: 30` rodado em 18/08 12:27 processou 100 linhas e
     trouxe **so pedidos de hoje** (93 pedidos). E a limitacao `ORDER BY received_at DESC LIMIT` do
     §1.4 acontecendo ao vivo — o backfill manual nunca alcanca lacunas que ficaram para tras.

  **Nao usar o backfill manual por janela para fechar isto** — ele tem exatamente o defeito que
  criou a situacao. O caminho e' o ciclo incremental por marca d'agua, que ja esta parado no lugar
  certo. Volume por dia aguardando ingestao: 12/08 2.337 · 13/08 6.652 · 14/08 6.759 · 15/08 3.066
  · 16/08 1.702 · 17/08 2.748 · 18/08 2.545 pedidos.

  **Precede o descongelamento**: religar producao com este buraco aberto poe o sistema de pe
  exibindo numero errado. Tambem precede qualquer correcao de rateio de gateway — sao R$ 3,3M
  ausentes contra R$ 12,4k mal atribuidos.

- O `wrangler deploy` do `cloudflare/worker-sync-cron` **nao foi executado** — o `"crons": []` esta
  commitado (`7085781`), mas os triggers seguem registrados no Cloudflare ate o deploy. Hoje eles
  batem no 503 do gate, entao nao custam nada, mas o corte na origem ainda esta pendente.
- Ambiente local com Postgres em Docker: adiado por decisao explicita ("corrigir a raiz primeiro"),
  ainda que seja pre-requisito pratico das etapas 3-7.
