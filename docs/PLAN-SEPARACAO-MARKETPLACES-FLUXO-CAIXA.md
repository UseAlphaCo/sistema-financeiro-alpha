# Plano de Implementacao - Separacao Marketplaces e Fluxo de Caixa

Data: 2026-08-26
Base: `main` em ff20a0d, sincronizada em `dev` por fast-forward
Referencia de backlog: docs/BACKLOG-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md

## Objetivo

Desfazer a sobreposicao entre duas telas que hoje sao uma so:

- A pagina que lista vendas/pedidos/transacoes de marketplace passa a se chamar
  **Marketplaces**, na rota `/marketplaces`.
- A rota `/fluxo-de-caixa` passa a servir uma tela NOVA, alimentada
  exclusivamente pelos registros cadastrados em Lancamentos (`source` `manual` e
  `import`), sem nenhuma interferencia de vendas.

## Diagnostico

A tela atual ja e de marketplace por construcao -- nao e questao de rotulo:

- `listMarketplaceReadModelPaginated` forca `type: "income"` e
  `sources: MIRROR_SOURCES` (src/features/transactions/read-model.ts:340-350).
  A tabela nunca mostrou lancamentos.
- O export CSV/XLSX reusa a mesma listagem
  (src/features/cash-flow/export-jobs.ts:251).
- Os KPIs tambem descartam lancamentos: com o mirror ligado (default), passa-se
  `sources: ["integration","webhook"]` (src/features/cash-flow/service.ts:413),
  e em src/features/transactions/read-model.ts:181 esse conjunto e filtrado para
  `manual`/`import`, resultando em `where.source = { in: [] }` -- zero linhas do
  Prisma.

Consequencia para o esforco: o rename e largamente mecanico; o trabalho real e
construir a tela de Fluxo de Caixa, que hoje nao existe.

## Escopo confirmado

- `/marketplaces` = tela atual, sem mudanca funcional: KPIs, "Por origem",
  tabela de entradas, aviso de frescor de dados e export CSV/XLSX.
- `/fluxo-de-caixa` = tela nova: KPIs Entradas/Saidas/Saldo liquido com
  comparativo, filtros (preset, data inicial, data final, categoria, tipo),
  tabela paginada e quebra por categoria.
- CRUD continua exclusivamente em `/lancamentos`. A tela nova e somente leitura.
- Export CSV/XLSX continua exclusivamente em Marketplaces.
- Dashboard nao muda.
- Todo o trabalho em `dev`. `main` nao recebe commits deste plano; a promocao
  `dev -> main` e decisao separada.

## Regras e decisoes de negocio

- Recorte de dados da tela nova: `deletedAt IS NULL`,
  `source IN ('manual','import')`, `status IN ('approved','applied')`.
- `status` alinhado com o SQL de `aggregateTransactions`
  (src/features/cash-flow/service.ts:50-53). Consequencia deliberada:
  `/lancamentos` lista `source=manual` SEM filtro de status, entao uma linha
  `pending` aparece la e nao conta aqui. O criterio precisa estar escrito no
  subtitulo da tela, senao vira chamado de "os numeros nao batem".
- `type: "transfer"` nunca entra em Entradas, Saidas ou Saldo, e nao aparece na
  quebra por categoria (actions.ts proibe categoria em transfer). Fica na tabela
  e num contador proprio.
- `categoryId` nulo vira o bucket "Sem categoria", sempre por ultimo.
- Periodo anterior sem nenhuma linha e "sem base", nao zero: a tela mostra "sem
  base de comparacao", nunca `+0,0%` em verde.
- Datas sempre em dia de calendario de Brasilia, nunca no fuso do processo.
- Envelope de API, `ActionResult` e `withApiSecurity` preservados.

## Estado atual de `main` que condiciona o plano

1. A leitura materializada e o default desde 26/08
   (src/shared/read-model-config.ts:49-54): `FINANCIAL_READ_MODEL_MATERIALIZED
   !== "false"`. A listagem de Marketplaces ja pagina no banco
   (`integration.financial_orders`), nao varre mais `mirror.raw_payloads` a cada
   visita.
2. A pagina ganhou avisos de frescor: `getFreshness` (page.tsx:222),
   `showTotals` (page.tsx:225, usado em 355/362/369/377/399) e
   `<DataFreshnessNotice>` (page.tsx:258). O arquivo passou de 476 para 499
   linhas.
3. `DataFreshnessNotice` vive em `src/app/(app)/_components/` e e compartilhado
   com o Dashboard -- nao se move no rename.

## Decisoes de arquitetura

### D1 - Rename por `git mv`
Preserva `git log --follow`. O historico desses arquivos importa (`5acf148`
correcao de fuso, `41041b6` base de comparacao, `ff7723d` avisos de cobertura).

### D2 - O redirect e condicional, nunca incondicional
`redirects()` do next.config.ts e avaliado ANTES do roteamento de filesystem.
Uma regra `/fluxo-de-caixa -> /marketplaces` tornaria a tela nova inalcancavel
para sempre. Nao da para redirecionar uma rota que vai ser reaproveitada.

Solucao: redirecionar apenas as URLs que carregam a assinatura da tela antiga:

```ts
{ source: "/fluxo-de-caixa", has: [{ type: "query", key: "marketplace" }],
  destination: "/marketplaces", permanent: false },
{ source: "/fluxo-de-caixa", has: [{ type: "query", key: "paymentMethod" }],
  destination: "/marketplaces", permanent: false },
```

Cobre todo link salvo porque `normalizeMarketplaceInput` devolve `"shopify"` por
omissao (page.tsx:73-90) e o form sempre submete o `<select name="marketplace">`.
`/fluxo-de-caixa` puro (item de menu e botao "Limpar") cai na tela nova, como
deve.

INVARIANTE: a tela nova nao pode aceitar as querystrings `marketplace` nem
`paymentMethod`. Comentar no next.config.ts e no page.tsx. Ja existe precedente
de `redirects()` no arquivo (`/financeiro/:path*`), que encadeia corretamente.

### D3 - A tela nova nao tem aviso de frescor nem `showTotals`
`getFreshness` devolve `null` sem a flag materializada e se apoia em
`getMaterializedLag()` + `resolveCoverage`
(src/app/(app)/_components/DataFreshnessNotice.tsx:37-45) -- tudo sobre o mirror.
O piso de 01/08 descreve o truncamento do mirror, nao o historico de
`FinancialTransaction`; aplica-lo a tela nova esconderia dado legitimo. A tela
nova tem estado vazio proprio.

### D4 - O servico mora em `src/features/cash-flow/`, com prefixo `entries-`
`scripts/check-boundaries.mjs` so proibe `shared -> core`, `shared -> features` e
`core -> features`, entao uma feature nova passaria no gate. A decisao e por
coesao: a semantica de periodo e a mesma nas duas telas, e dois donos para "o que
e o periodo anterior" e como se produz divergencia de numero entre telas.

Para nao arrastar o grafo do mirror (`service.ts -> read-model.ts ->
mirror-events-repository.ts`, pool `pg` com `max: 2`), extrair
`resolveCashFlowDateRange` e o `parseLocalIsoDate` privado (service.ts:263 e
service.ts:373) para `period.ts`, com re-export em `service.ts`.

### D5 - Consulta direta ao Prisma, sem passar pelo read model
Nao reutilizar `listPrismaTransactions` (read-model.ts:172): nao filtra `status`,
faz `findMany` sem `take` (traz a tabela inteira e pagina em memoria) e tem
`catch { return [] }` -- falha de banco viraria R$ 0,00 numa tela de conferencia
financeira. Um repositorio Prisma-only torna o isolamento ESTRUTURAL, nao uma
assercao de teste, e nao disputa o pool do CORE.

### D6 - Nao renomear a feature `cash-flow` nem `/api/financial/cash-flow/*`
A tabela `integration.cash_flow_export_jobs` e criada em runtime, as URLs nao sao
visiveis ao usuario, e um `?jobId=` aberto durante o deploy passaria a 404.
`computeCashFlow` continua alimentando o Dashboard, que fica. Se o rename vier
depois, que venha como commit isolado com `rewrites` por 30 dias.

## Status de execucao (atualizado em 26/08/2026)

### Resumo
- Fase 0 concluida: `dev` sincronizada com `main` (ff20a0d) e gate completo verde
  (lint, typecheck, boundaries, contracts, 126 testes em 18 arquivos, build).
- Fases 1 a 5 pendentes.

### Status por fase
- Fase 0 - Concluida
- Fase 1 - Pendente
- Fase 2 - Pendente
- Fase 3 - Pendente
- Fase 4 - Pendente
- Fase 5 - Pendente

### Pendencias operacionais
- Fechar por escrito, antes da Fase 3, tres decisoes de produto: tratamento de
  `transfer`, inclusao de `pending`, e se a quebra por categoria separa entrada
  de saida ou soma tudo. Cada uma invertida depois da Fase 4 custa 0,5 dia.
- Semear lancamentos `manual`/`import` no ambiente de validacao. Se o banco so
  tiver dado de marketplace, a verificacao da tela nova fica bloqueada.
- Promocao `dev -> main` nao faz parte deste plano.

---

## Fase 0 - Branch e registro

### Status atual
Concluida

### Objetivo
Colocar `dev` numa base que suporte o trabalho, e registrar o plano antes de
tocar em codigo.

### Entregas
1. `git checkout dev && git merge --ff-only main`. `dev` estava em `c9bdffb`,
   ancestral estrito de `main`, 52 commits atras e sem nenhum commit exclusivo.
2. Gate completo executado na base sincronizada.
3. Este documento e o backlog versionados.

### Justificativa da sincronizacao
Implementar sobre `dev` como ela estava era inviavel, nao por preferencia, mas
porque as dependencias do plano nao existiam la:

| Dependencia | main | dev (c9bdffb) |
|---|---|---|
| `startOfZonedDay` / `endOfZonedDay` / `zonedDayKey` | sim | nao |
| `mirrorCannotContribute` | sim | nao |
| `read-model-coverage.ts`, `read-model-freshness.ts` | sim | nao |
| `financial-orders-repository.ts`, `materialize-orders-job.ts`, `mirror-*` | sim | nao |
| `resolveCashFlowDateRange` sem o bug de ISO completo | sim | nao |

Sem `startOfZonedDay`/`zonedDayKey`, os testes que este plano especifica --
assercoes sobre `03:00:00.000Z` e `02:59:59.999Z` -- sao impossiveis de escrever,
e a tela nova nasceria com os bugs de fuso que `main` ja corrigiu.

### Arquivos alvo
- docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md
- docs/BACKLOG-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md

---

## Fase 1 - Extrair a semantica de periodo

### Status atual
Pendente

### Objetivo
Dar as duas telas uma fonte unica de "periodo" e "periodo anterior", sem que a
tela nova arraste o grafo de modulos do mirror.

### Entregas
1. Criar `period.ts` com `resolveCashFlowDateRange(filters, now)` e o
   `parseLocalIsoDate` privado, movidos sem alteracao de comportamento.
2. `service.ts` re-exporta `resolveCashFlowDateRange`.
3. Nenhuma mudanca de UI. Commit isolado, gate verde.

### Definicao de pronto
`src/features/cash-flow/service.test.ts` passa sem uma linha alterada -- prova de
que o move foi neutro.

### Arquivos alvo
- src/features/cash-flow/period.ts (novo)
- src/features/cash-flow/service.ts

---

## Fase 2 - Mover a tela atual para /marketplaces

### Status atual
Pendente

### Objetivo
Publicar Marketplaces com paridade total e nenhum link quebrado, mantendo
`/fluxo-de-caixa` funcional (redirecionando) ate a tela nova existir.

### Entregas
1. `git mv src/app/(app)/fluxo-de-caixa src/app/(app)/marketplaces`; renomear
   `FluxoDeCaixaTable.tsx` para `MarketplacesTable.tsx` e o componente exportado.
2. Em `marketplaces/page.tsx`: h1 nas linhas 166 e 231; hrefs internos 240 e 331;
   evento de log `"fluxo_caixa_marketplace_entries_failed"` para
   `"marketplaces_entries_failed"` (192).
3. A chamada `getFreshness` / `showTotals` / `<DataFreshnessNotice>` (222, 225,
   258 e os usos em 355/362/369/377/399) vai junto SEM alteracao -- e a tela que
   continua lendo o mirror. O componente permanece em `_components/`.
4. Em `MarketplacesTable.tsx`: `pageLink` para `/marketplaces` (145);
   `COLUMN_STORAGE_KEY` para `"marketplaces-visible-columns"` (40), com leitura
   de fallback unica da chave antiga quando a nova estiver ausente (preserva a
   preferencia de coluna de quem ja usa; sem escrita na chave antiga).
5. `layout.tsx`: o item "Fluxo de Caixa" vira "Marketplaces" -> `/marketplaces`.
   Nesta fase nao existe item "Fluxo de Caixa" no menu.
6. `next.config.ts`: redirect INCONDICIONAL TEMPORARIO `/fluxo-de-caixa` ->
   `/marketplaces` (`permanent: false`). E o que mantem este commit funcional; a
   Fase 4 o substitui pela versao com `has`.
7. `proxy.ts`: `"/marketplaces"` em `PROTECTED_PAGE_PREFIXES` (8) e
   `"/marketplaces/:path*"` no `matcher` (187). MANTER as entradas de
   `/fluxo-de-caixa` nos dois -- a rota volta na Fase 4.
8. Export: `addWorksheet("Fluxo de caixa")` para `"Marketplaces"`
   (export-jobs.ts:219) e `fluxo-caixa-<stamp>` para `marketplaces-<stamp>` (279).
   O schema `integration.cash_flow_export_jobs` NAO muda.

### Definicao de pronto
`grep -rn "fluxo-de-caixa" src/app/\(app\)/marketplaces` sem resultado; deslogado,
`/marketplaces` redireciona para `/login`.

### Arquivos alvo
- src/app/(app)/marketplaces/page.tsx (movido)
- src/app/(app)/marketplaces/MarketplacesTable.tsx (movido/renomeado)
- src/app/(app)/marketplaces/ExportControls.tsx (movido, conteudo inalterado)
- src/app/(app)/layout.tsx
- src/proxy.ts
- next.config.ts
- src/features/cash-flow/export-jobs.ts

---

## Fase 3 - Dominio dos lancamentos (sem UI)

### Status atual
Pendente

### Objetivo
Entregar a consulta e a agregacao da tela nova, testaveis, antes de existir tela.
Nada muda para o usuario nestes commits.

### Entregas
1. `entries-types.ts`: `CashFlowEntriesFilters`, `CashFlowEntriesTotals`,
   `CashFlowEntriesByCategory`, `CashFlowEntriesSummary`.
2. `entries-validations.ts`: schema Zod reusando `PERIOD_PRESETS`, `page` default
   1 e `limit` default 50 restrito a 25/50/100.
3. `entries-actions.ts`: `getCashFlowEntriesAction` no contrato `ActionResult<T>`.
4. `entries-repository.ts`, so Prisma:
   - `buildEntriesWhere(range, filters)` EXPORTADA e pura -- e o ponto de teste
     do requisito "zero marketplace".
   - `sumEntriesByType` e `groupEntriesByCategory` via `groupBy` (`_sum` de `Int`
     volta `number | null`, sem bigint).
   - `listEntriesPaginated` com `count` + `findMany({ skip, take, orderBy })`.
   - Sem `try/catch` engolindo erro: falha sobe.
   - Nao importar `read-model-coverage` nem `read-model-freshness` (D3).
5. `entries-service.ts`: `computeCashFlowEntries(filters, now = new Date())` --
   `now` por parametro desde o inicio, ao contrario de `computeCashFlow`, que
   chama `new Date()` internamente e por isso so e testavel pela borda. Periodo
   anterior via `getPreviousPeriodRange`; join de nome/cor de categoria em memoria
   com `listCategories()` (tabela pequena, e nao ha relacao Prisma entre
   `FinancialTransaction` e `TransactionCategory`).
6. `entries-service.test.ts` cobrindo: fronteira de dia em Brasilia
   (`03:00:00.000Z` / `02:59:59.999Z`); filtro parcial (so `startDate`); virada de
   dia UTC vs Brasilia; `transfer`; `categoryId` nulo; soft delete e `status`
   sempre no where; paginacao (ultima pagina, alem do total, total zero); e a
   distincao "sem base" vs "base zero".

### Definicao de pronto
O modulo nao importa `@/features/transactions/read-model` nem `pg`; suite passa
sem `DATABASE_URL` no ambiente.

### Arquivos alvo
- src/features/cash-flow/entries-types.ts (novo)
- src/features/cash-flow/entries-validations.ts (novo)
- src/features/cash-flow/entries-actions.ts (novo)
- src/features/cash-flow/entries-repository.ts (novo)
- src/features/cash-flow/entries-service.ts (novo)
- src/features/cash-flow/entries-service.test.ts (novo)

---

## Fase 4 - Tela nova em /fluxo-de-caixa

### Status atual
Pendente

### Objetivo
Publicar Fluxo de Caixa lendo so lancamentos, e trocar o redirect incondicional
pelo condicional no mesmo commit.

### Entregas
1. `page.tsx` como Server Component (`dynamic = "force-dynamic"`), partindo do
   layout da tela de marketplaces. Le `preset`, `startDate`, `endDate`,
   `categoryId`, `type`, `page`, `limit`. NAO aceita `marketplace` nem
   `paymentMethod` (invariante da D2 -- comentar no arquivo). Sem
   `ExportControls`, sem `DataFreshnessNotice`.
2. Tres KPIs -- Entradas, Saidas, Saldo liquido -- com delta vs periodo anterior
   e cor invertida em Saidas. Sem base de comparacao mostra "sem base", nao um
   travessao verde.
3. Filtros num `<form method="GET">` no mesmo desenho do atual: presets como
   links, datas, categoria, tipo, linhas por pagina, Filtrar/Limpar.
4. `CashFlowEntriesTable.tsx` como Server Component (sem seletor de colunas,
   logo sem `localStorage` e sem bundle de cliente): Data, Tipo, Categoria,
   Descricao, Origem (`formatOriginLabel`, que ja tem `manual` e `import`),
   Valor; `tfoot` com total da pagina; paginacao por `<a href>` preservando os
   filtros.
5. `CashFlowByCategory.tsx`: total, contagem e percentual por categoria,
   separando entrada e saida, com a cor da categoria. Ordenacao determinista
   (total desc, nome como desempate). "Sem categoria" sempre por ultimo.
6. Estado vazio explicito ("Nenhum lancamento aprovado no periodo" + link para
   `/lancamentos`) em ramo SEPARADO do erro de banco (aviso ambar +
   `logError("cash_flow_entries_failed", ...)`). Vazio nunca pode se ler como
   "nao movimentou nada" -- vale especialmente porque read-model-config.ts:61
   registra que `FinancialTransaction` estava com zero linhas.
7. `next.config.ts`: substituir o redirect incondicional pelas duas regras `has`
   da D2.
8. `layout.tsx`: reintroduzir "Fluxo de Caixa" -> `/fluxo-de-caixa`, ao lado de
   "Marketplaces".
9. `alterar-senha/page.tsx`: `callbackUrl` (60) e `router.push` (70) para
   `/dashboard`, consistente com src/app/page.tsx e login/page.tsx:20. Hoje
   apontam para `/fluxo-de-caixa`, que era a tela de vendas; mandar o usuario
   pos-troca-de-senha para uma tela de lancamentos manuais seria pior ainda.

### Definicao de pronto
`/fluxo-de-caixa` puro serve a tela nova; `/fluxo-de-caixa?marketplace=shopify`
redireciona com a query intacta. As entregas 7 e 8 nao podem ser separadas da 1
em commits distintos -- separar produziria 404 ou tela inalcancavel.

### Arquivos alvo
- src/app/(app)/fluxo-de-caixa/page.tsx (novo)
- src/app/(app)/fluxo-de-caixa/CashFlowEntriesTable.tsx (novo)
- src/app/(app)/fluxo-de-caixa/CashFlowByCategory.tsx (novo)
- next.config.ts
- src/app/(app)/layout.tsx
- src/app/(app)/alterar-senha/page.tsx

---

## Fase 5 - Isolamento, verificacao e documentacao

### Status atual
Pendente

### Objetivo
Provar que as duas telas nao se contaminam, verificar em ambiente real e deixar
registrado que `cash-flow` passou a hospedar dois servicos.

### Entregas
1. Teste de regressao de isolamento, lado novo: `vi.mock` de
   `@/features/transactions/read-model` e de `pg` que LANCAM se chamados -- o
   isolamento passa a ser estrutural. Caso de contaminacao: linha
   `source: "webhook"` injetada pelo repositorio falso e descartada pelo
   agregador.
2. Teste de regressao, lado Marketplaces: estender
   `src/features/transactions/read-model.test.ts` provando que
   `listMarketplaceReadModelPaginated` nao devolve linha `manual`/`import` nem
   `expense`. Hoje e garantido, mas nao ha teste que o prove.
3. Verificacao manual conforme a secao abaixo.
4. `docs/features/feature-cash-flow.md` separado em duas secoes: Marketplaces
   (mirror/materializado, `computeCashFlow`) e Lancamentos (Prisma direto,
   `computeCashFlowEntries`), com o criterio de `status`, a diferenca deliberada
   em relacao a `/lancamentos` e a ausencia de aviso de frescor na tela nova.
5. `docs/architecture/CONTEXT-TREE.md` com as rotas novas.
6. Data-alvo de remocao das duas regras `has` anotada no next.config.ts.

### Definicao de pronto
Remover o filtro de origem de qualquer um dos dois lados faz pelo menos um teste
falhar.

### Arquivos alvo
- src/features/cash-flow/entries-service.test.ts
- src/features/transactions/read-model.test.ts
- docs/features/feature-cash-flow.md
- docs/architecture/CONTEXT-TREE.md
- next.config.ts

---

## Verificacao tecnica obrigatoria

### Status atual
Executada na base sincronizada (Fase 0). Pendente para as Fases 1 a 5.

1. Executar npm run lint.
2. Executar npm run typecheck.
3. Executar npm run check:boundaries.
4. Executar npm run check:contracts.
5. Executar npm run test -- incluindo `service.test.ts` intacto (prova da
   neutralidade da Fase 1) e as suites novas.
6. Executar npm run build.
7. Executar testes manuais, com `npm run dev` e banco real (nao script isolado).

### Roteiro manual

Pre-requisito: criar em `/lancamentos` 4 linhas no mesmo dia -- 1 entrada
aprovada, 1 saida aprovada, 1 entrada SEM categoria, 1 pendente. Anotar os
valores.

1. `/marketplaces?preset=yesterday&marketplace=shopify` -- cards, tabela e aviso
   de frescor identicos ao que era `/fluxo-de-caixa`; export CSV e XLSX concluem,
   com nome de arquivo e nome de aba novos.
2. `/marketplaces` -- trocar preset, marketplace e linhas por pagina; a URL tem
   de continuar em `/marketplaces` (e onde o rename costuma vazar). Esconder e
   mostrar colunas e recarregar: preferencia preservada.
3. `/marketplaces?preset=today` -- confirmar que `showTotals` ainda suprime os
   totais quando a materializacao do dia nao rodou (regressao do ff20a0d).
4. `/fluxo-de-caixa?marketplace=shopify` (bookmark antigo) -- 302 para
   `/marketplaces` com a query intacta.
5. `/financeiro/fluxo-de-caixa?marketplace=shopify` -- cadeia dupla de redirect
   ate `/marketplaces`.
6. `/fluxo-de-caixa` puro -- tela nova. Nenhum numero de marketplace, nenhum
   aviso de frescor. O pendente nao conta; o sem categoria conta no KPI e aparece
   como "Sem categoria".
7. `/fluxo-de-caixa?startDate=<dia dos lancamentos>` SEM `endDate` -- tem de
   trazer aquele dia, nao cair no preset.
8. Paridade: com `limit` maior que o total, a soma da coluna de valores bate com
   Entradas menos Saidas do card.
9. `/fluxo-de-caixa?page=999` -- vazio com mensagem, sem stack trace.
10. Excluir (soft delete) um lancamento em `/lancamentos` -- KPI e tabela caem
    juntos.
11. `/dashboard` -- numeros e aviso de frescor inalterados em relacao ao print de
    antes.
12. Deslogado, `/marketplaces` -- redireciona para `/login`.

### Sem cobertura automatizada, deliberadamente

Renderizacao de cards/tabela/filtros, resposta HTTP das rotas, persistencia do
`localStorage`, o redirect e a guarda do proxy.ts. O repositorio nao tem nenhum
`.test.tsx` nem teste de rota entre os 22 `route.ts`; a logica que erra de verdade
(fuso, agregacao, `where`, paginacao) esta toda coberta uma camada abaixo.
Introduzir a infra custaria +1,5 a 2 dias (Testing Library + jsdom, e ainda assim
Server Components async ficam de fora) ou +3 a 4 dias (Playwright). Recomendacao:
manter o roteiro manual como gate.

## Riscos e mitigacoes

- Risco: regra `has` deixar de fora um link editado a mao
  (`/fluxo-de-caixa?preset=d30` sem `marketplace`).
  - Mitigacao: aviso na tela nova com link para Marketplaces durante a janela de
    transicao; as duas regras cobrem tudo que a UI antiga era capaz de gerar.
- Risco: a tela nova ganhar um filtro `marketplace` no futuro e ficar
  inalcancavel em silencio.
  - Mitigacao: invariante comentada no next.config.ts e no page.tsx, e remocao
    das regras na data agendada.
- Risco: divergencia percebida com `/lancamentos`, que lista sem filtro de status.
  - Mitigacao: criterio escrito no subtitulo da tela e na doc de feature.
- Risco: `FinancialTransaction` quase vazia hoje -- a tela pode nascer sem dados.
  - Mitigacao: estado vazio que nomeia a causa, em ramo separado do erro de banco.
- Risco: perder a logica de frescor no `git mv` -- `showTotals` aparece em 5
  pontos da pagina.
  - Mitigacao: passo 3 do roteiro manual.
- Risco: regressao silenciosa de Marketplaces no `git mv` (import quebrado so em
  runtime).
  - Mitigacao: npm run build compila todas as rotas; conferir manualmente as 4
    URLs de export em ExportControls.tsx, que sao strings e nao passam pelo
    compilador.
- Risco: performance do `groupBy` quando a tabela crescer -- ha indices
  individuais em `occurredAt`, `source`, `status` e `deletedAt`, mas NAO em
  `categoryId`.
  - Mitigacao: `take` sempre presente e `limit` com teto de 100; indice composto
    `(deletedAt, source, occurredAt)` registrado no backlog, fora deste escopo.
- Risco: nome de evento de log alterado quebrar alerta externo.
  - Mitigacao: nenhuma outra referencia a
    `fluxo_caixa_marketplace_entries_failed` no repositorio; conferir dashboards
    de log antes do deploy.

## Ordem recomendada de execucao

1. Fase 0 (concluida)
2. Fase 1
3. Fase 2
4. Fase 3
5. Fase 4
6. Fase 5

Todo commit deixa o app funcional. Os testes de cada camada entram logo apos a
camada, nao no fim -- e a forma de nao descobrir que o agregador esta errado
depois da UI ja estar construida em cima dele.
