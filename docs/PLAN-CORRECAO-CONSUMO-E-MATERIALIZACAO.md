# Corrigir a raiz do consumo e materializar o read model financeiro

> **Status:** em execucao. Producao congelada (commits `8b1003e` e `2620098`).
> Etapa 0 concluida (`661107c`). Parte 1 com 1.1, 1.2 e a raiz do 1.4 concluidas (`0dfd481`),
> mais o hardening de OMS read-only (`edfb908`) — **corrigido**, ver item 1 abaixo, o hardening
> original nao funcionava contra o pooler real. Pendentes: 1.3, 1.5 e a Parte 2 inteira.
>
> **Validacao contra banco real: itens 1-5 rodados. Item 1 revelou bug real e foi corrigido; itens
> 2-5 passaram limpos.** Falta so o item 6, que e uma decisao de design, nao uma execucao.
> `npm run check` passa (53 testes, build). Ver "Verificacao pendente" no fim para o detalhe de cada
> item.

## Contexto

O CORE FIN esta congelado em producao (paginas e `/api/internal/*` devolvendo 503). O congelamento
provou a causa: com os crons cortados, o `/api/health` foi de **4 em 6 amostras com `db=down` para
15 em 15 com `db=up`**. O consumo que derrubava o Supabase e estourava limites na Vercel vinha do
ciclo de sync, nao de trafego de usuario.

Sao dois problemas distintos, e o segundo e o que trava o sistema no dia a dia:

**1. O sync desperdica trabalho.** Em [oms-repository.ts:42](../src/workers/sync/repositories/oms-repository.ts#L42)
a consulta ao OMS filtra `received_at >= NOW() - ($1 * INTERVAL '1 day')`, e
[worker-sync-jobs.ts:146-152](../src/features/integration/worker-sync-jobs.ts#L146-L152) passa
`backfillDays: 30` na primeira run de **todo** job. Com o cron em `*/5`, isso e uma varredura de
janela de 30 dias 288 vezes por dia, sempre sobre os mesmos 200 registros mais recentes
(`ORDER BY received_at DESC LIMIT 200`). Somado a `awaitCompletion: true`, que segura a function
ate o job terminar, e a pools em porta 5432 (session mode, 1:1 com conexao real do Postgres).

**2. Toda leitura da aplicacao varre `mirror.raw_payloads`.** A tabela tem ~1,4M linhas de
**eventos** (nao pedidos) com `payload_json` de 10-30KB. A consulta em
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
> roda quando `backfillDays` esta setado. Com `SYNC_CONTROL_TARGET=core` (default), a varredura de
> janela **e** o unico mecanismo de ingestao: tirar o backfill e so drenar esvaziaria a fila para
> sempre. O `integration.sync_events` do OMS, alimentado por trigger, so e lido no fallback
> `SYNC_CONTROL_TARGET=oms`.

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

### 1.3 Reduzir a frequencia

`*/5` era desproporcional mesmo sem o rescan. Definir a frequencia pelo volume real de pedidos ao
restaurar `triggers.crons` em [wrangler.jsonc](../cloudflare/worker-sync-cron/wrangler.jsonc).

### 1.4 Corrigir o alcance do backfill — RESOLVIDO NO CAMINHO AUTOMATICO

`findRawPayloadCandidates` ordena `DESC` com `LIMIT`, entao so enxerga os N mais recentes:
**lacunas antigas dentro da janela nunca sao alcancadas**. E por isso que existem
`scripts/backfill-june-mirror.ts` e `scripts/process-backlog.ts`.

O keyset ascendente do item 1.1 resolve isto para o ciclo automatico: o cursor caminha para frente
e nao deixa buraco para tras. **O backfill manual por janela continua com `DESC LIMIT`** — nao foi
alterado. Fechar lacunas historicas segue sendo trabalho do carregamento em bloco de §2.4, que e
mais direto que fazer o worker rastejar. Reavaliar se o caminho manual ainda precisa de keyset
depois que §2.4 rodar.

### 1.5 Session mode -> transaction mode (por ultimo, isolado)

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
aplicacao: em vez de fazer o worker rastejar 1,4M linhas, a janela e transferida em bloco por SQL e
depois materializada em ~11 execucoes do proprio job diario. Nao e preciso escrever nenhum script de
backfill dedicado.

### Passo 1 — garantir o mirror completo na janela

O `mirror.raw_payloads` ja deve ter esse periodo (o sync roda ha tempo com janela de 30 dias), mas
**nao da para confiar**: pela limitacao do `ORDER BY received_at DESC LIMIT` descrita em §1.4, o
backfill automatico nunca alcanca lacunas que fiquem para tras dos N mais recentes. A carga em bloco
serve justamente para fechar isso de uma vez, sem depender do worker.

Reaproveitar as Fases 2-4 de
[RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md](RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md), trocando
`NOW() - INTERVAL '10 days'` por `>= '2026-08-01'`. O procedimento ja esta pronto e correto: as 10
colunas exportadas do OMS batem 1:1 com o `INSERT` de
[core-repository.ts:242-282](../src/workers/sync/repositories/core-repository.ts#L242-L282), e
`synced_at`/`mirror_updated_at` sao preenchidas do lado do CORE.

```bash
# Extracao (OMS permanece read-only: e um SELECT)
psql "$OMS_DB_URL" -c "\copy ( \
  SELECT id, source, external_order_id, event_type, payload_json, headers_json, \
         received_at, processed_at, processing_status, error_message \
  FROM public.raw_payloads \
  WHERE COALESCE(received_at, processed_at) >= '2026-08-01' \
) TO 'tmp/oms-export/raw_payloads_2026-08.csv' CSV HEADER"
```

Carga no CORE: **tabela temporaria + `INSERT ... SELECT ... ON CONFLICT (id) DO UPDATE`**, exatamente
como a Fase 3 do runbook. Nunca `\copy` direto na tabela viva — `COPY` nao tem `ON CONFLICT`, e a
carga precisa ser reexecutavel.

Duas notas sobre a ferramenta, porque mudam o comando:

- **`supabase db dump` nao filtra linhas.** Ele e um wrapper de `pg_dump` e trabalha por
  tabela/schema, sem `WHERE`. Serve para o backup de seguranca antes de mexer (recomendado tirar
  um), mas a transferencia recortada por data tem que ser `\copy` com `SELECT`, como acima.
- A **CLI do Supabase nao esta instalada** nesta maquina (so `wrangler`); `psql`/`pg_dump` sao o
  caminho direto e ja sao o que o runbook pressupoe.

Se o CSV ficar grande (payload de 10-30KB por linha), quebrar por dia ou por semana e comprimir —
o `ON CONFLICT` torna cada pedaco independente e reexecutavel.

**Validacao** (Fase 4 do runbook): contagem no OMS e no CORE com **exatamente o mesmo filtro**, e
amostra por `id`. Divergencia aqui invalida tudo que vem depois.

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

| # | Etapa | Verificacao |
|---|---|---|
| 0 | ~~Curto-circuito do `/lancamentos` (§2.5)~~ **feito** (`661107c`) | Unit com `pg` mockado: `pool.query` nao e chamado para `{source:"manual"}`, `categoryId`, `type!=income` nem `sources` disjunto — mais 3 controles provando que o caminho normal ainda consulta |
| 1 | ~~§1.1, §1.2, raiz do §1.4~~ **feito** (`0dfd481`, `edfb908`); faltam §1.3 e §1.5 | `npm run check` verde. **Validado contra banco real, itens 1-5** — ver "Verificacao pendente" |
| 2 | Extrair `mirror-order-mapper.ts` (§2.2) | Vitest sem banco: pago/nao pago, dedup "pago vence recencia", `amountCents<=0`, gateway via `spr` vs heuristica, `search_text` identico ao haystack atual |
| 3 | Migration + `ensureFinancialOrdersTable` + upsert (§2.1) | Teste de integracao no padrao de [worker-job-repository.test.ts](../src/features/integration/worker-job-repository.test.ts) (skip sem `CORE_DB_URL`): ensure 2x idempotente, upsert com mesmo hash nao muda `materialized_at` |
| 4 | Job diario + rota de cron (§2.3) | `curl` autenticado na rota para um dia; comparar `count(*)`/`sum(amount_cents)` contra o `/fluxo-de-caixa` do mesmo dia |
| 5 | Carga inicial: dump OMS->CORE de 2026-08-01+ e materializacao da janela (§2.4) | Contagem OMS vs CORE com o mesmo filtro; depois, contagem por dia vs pedidos distintos no mirror — a diferenca deve ser so os nao pagos, quantificada |
| 6 | Leitura atras da flag + piso de data (§2.5, §2.4) | `compare-read-model.ts` zerado de 2026-08-01 em diante; periodo anterior ao piso cai no legado, nao em zero; paginacao paginas 1 e 2 sem sobreposicao |
| 7 | `computeCashFlow` em SQL (§2.6) | Teste puro do fold; `verify:shopify` para D-1 |
| 8 | Cutover: remover caminho legado, flag e `RECEIVED_AT_GRACE_MS`; restaurar crons | So depois de o piso alcancar o inicio do historico. `npm run check`; descongelar producao |

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

Sao pre-requisitos para descongelar producao. Itens 1-5 rodados contra banco real; item 6 e decisao
de design, nao execucao.

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

   **Nota lateral:** os metodos de fallback (`acquireExecutionLock`/`releaseExecutionLock`/etc.,
   usados apenas quando `SYNC_CONTROL_TARGET=oms`) agora pegam uma conexao fisica nova a cada
   chamada, entao um lock adquirido numa chamada nao seria liberavel pela mesma sessao numa chamada
   seguinte. Nao corrigido de proposito: esse caminho ja quebra antes disso, em
   `ensureInfrastructure` (ver item 6) — e a correcao daquele caminho depende da decisao de design
   ainda em aberto, nao faz sentido polir um fallback que pode ser removido.

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
6. **`SYNC_CONTROL_TARGET=oms` agora falha de proposito — confirmado, nao so hipotetico.** Antes da
   correcao do item 1, isso nao era garantido (a garantia read-only nem funcionava). Com o `SET`
   explicito agora em vigor, `ensureInfrastructure()` do `OmsRepository` (`CREATE SCHEMA`/`ALTER
   TABLE`) vai falhar mesmo, na primeira chamada, com "read-only transaction" — nao precisa rodar
   contra banco para confirmar, e o design ja garante isso. Decisao pendente: **remover o fallback
   morto** (simplifica, ja que nao funciona e o hardening o tornou desnecessario) ou redesenhar para
   um modo que nunca tente escrever no OMS. Nao decidido ainda.

## Pendencias operacionais fora do plano

- O `wrangler deploy` do `cloudflare/worker-sync-cron` **nao foi executado** — o `"crons": []` esta
  commitado (`7085781`), mas os triggers seguem registrados no Cloudflare ate o deploy. Hoje eles
  batem no 503 do gate, entao nao custam nada, mas o corte na origem ainda esta pendente.
- Ambiente local com Postgres em Docker: adiado por decisao explicita ("corrigir a raiz primeiro"),
  ainda que seja pre-requisito pratico das etapas 3-7.
