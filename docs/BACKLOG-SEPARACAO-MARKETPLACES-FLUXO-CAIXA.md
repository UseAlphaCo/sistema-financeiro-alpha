# Backlog Tecnico: Separacao Marketplaces e Fluxo de Caixa

Data: 2026-08-26
Status: Fase 0 concluida, Fases 1 a 5 prontas para execucao
Referencia de plano: docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md
Branch de execucao: `dev` (sincronizada com `main` em ff20a0d)

## Convencoes
- Prioridade: P0 (critico), P1 (alto), P2 (medio)
- Estimativa: em dias uteis de engenharia
- Dependencias: ticket(s) que devem finalizar antes
- Definicao de pronto: criterio minimo para fechar ticket

## Tickets

### Fase 0 - Branch e registro

1. MKTFLX-000 - Sincronizar dev com main
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: nenhuma
- Escopo:
  - `git checkout dev && git merge --ff-only main`. `dev` estava em c9bdffb,
    ancestral estrito de `main`, 52 commits atras e sem commit exclusivo.
  - Rodar o gate completo na base sincronizada, antes de somar qualquer mudanca.
- Definicao de pronto:
  - `git rev-parse dev` igual a `git rev-parse main` e os 6 passos do gate verdes.
- Status: CONCLUIDO (126 testes em 18 arquivos, build ok)

2. MKTFLX-001 - Publicar plano e backlog em docs
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-000
- Escopo:
  - Criar docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md e este backlog.
  - `## Status de execucao` do plano nasce com as fases pendentes e e atualizado
    a cada fase concluida.
- Definicao de pronto:
  - Documentos versionados em `dev`, com o backlog referenciando o plano pelo
    caminho.

### Fase 1 - Fundacao

3. MKTFLX-002 - Extrair a semantica de periodo para period.ts
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-001
- Escopo:
  - Mover `resolveCashFlowDateRange` e o `parseLocalIsoDate` privado de
    src/features/cash-flow/service.ts (linhas 263 e 373) para
    src/features/cash-flow/period.ts, com re-export em service.ts.
  - Motivo: a tela nova precisa da mesma semantica de periodo sem arrastar o
    grafo service.ts -> read-model.ts -> mirror-events-repository.ts (pool pg com
    max 2 conexoes).
- Definicao de pronto:
  - src/features/cash-flow/service.test.ts passa sem uma linha alterada.

### Fase 2 - Marketplaces

4. MKTFLX-003 - Mover a tela para /marketplaces
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-002
- Escopo:
  - `git mv src/app/(app)/fluxo-de-caixa src/app/(app)/marketplaces`; renomear
    FluxoDeCaixaTable.tsx para MarketplacesTable.tsx e o componente exportado.
  - h1 nas linhas 166 e 231; hrefs internos 240 e 331; pageLink em
    MarketplacesTable.tsx:145.
  - A chamada getFreshness / showTotals / DataFreshnessNotice (222, 225, 258 e os
    usos em 355/362/369/377/399) vai junto sem alteracao. O componente permanece
    em _components/, compartilhado com o Dashboard.
- Definicao de pronto:
  - `grep -rn "fluxo-de-caixa" src/app/\(app\)/marketplaces` sem resultado.

5. MKTFLX-004 - Navegacao, proxy e redirect temporario
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-003
- Escopo:
  - `"/marketplaces"` em PROTECTED_PAGE_PREFIXES (src/proxy.ts:8) e
    `"/marketplaces/:path*"` no matcher (src/proxy.ts:187). Manter as entradas de
    `/fluxo-de-caixa`: a rota volta na Fase 4.
  - Item de menu em src/app/(app)/layout.tsx:23 passa a "Marketplaces".
  - Redirect incondicional temporario em next.config.ts, que mantem este commit
    funcional. A Fase 4 o substitui.
- Definicao de pronto:
  - Deslogado, `/marketplaces` redireciona para `/login`. Rota autenticada fora
    do matcher e o unico defeito desta lista com consequencia de seguranca.

6. MKTFLX-005 - Chaves de estado, telemetria e nomes de export
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-003
- Escopo:
  - COLUMN_STORAGE_KEY de `"fluxo-de-caixa-visible-columns"` para
    `"marketplaces-visible-columns"` (MarketplacesTable.tsx:40), com leitura de
    fallback unica da chave antiga; sem escrita na chave antiga.
  - Evento de log `"fluxo_caixa_marketplace_entries_failed"` para
    `"marketplaces_entries_failed"` (page.tsx:192).
  - `addWorksheet("Fluxo de caixa")` para `"Marketplaces"` e
    `fluxo-caixa-<stamp>` para `marketplaces-<stamp>`
    (src/features/cash-flow/export-jobs.ts:219 e 279).
  - O schema integration.cash_flow_export_jobs NAO muda: e criado em runtime e
    renomear exigiria migration sem valor de usuario.
- Definicao de pronto:
  - Preferencia de colunas preservada apos o deploy; export baixa com nome
    coerente com a tela.

### Fase 3 - Dominio dos lancamentos

7. MKTFLX-006 - Tipos, validacao e action
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-002
- Escopo:
  - entries-types.ts, entries-validations.ts (Zod reusando PERIOD_PRESETS, page
    default 1, limit default 50 restrito a 25/50/100) e entries-actions.ts no
    contrato ActionResult<T>.
- Definicao de pronto:
  - Filtros invalidos devolvem ActionResult de erro, sem lancar.

8. MKTFLX-007 - Repositorio Prisma-only de lancamentos
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: MKTFLX-006
- Escopo:
  - buildEntriesWhere exportada e pura; sumEntriesByType e groupEntriesByCategory
    via groupBy; listEntriesPaginated com count + findMany skip/take.
  - Where canonico: deletedAt null, source in (manual, import), status in
    (approved, applied), occurredAt entre os instantes resolvidos.
  - Nao reutilizar listPrismaTransactions (read-model.ts:172): nao filtra status,
    faz findMany sem take e tem catch que devolve lista vazia -- falha de banco
    viraria R$ 0,00 na tela.
  - Nao importar read-model-coverage nem read-model-freshness: o piso e o lag sao
    do mirror, nao do historico de FinancialTransaction.
  - Erro de banco propaga.
- Definicao de pronto:
  - O modulo nao importa @/features/transactions/read-model nem pg.

9. MKTFLX-008 - Servico de agregacao e comparativo
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: MKTFLX-007
- Escopo:
  - computeCashFlowEntries(filters, now = new Date()) com `now` por parametro
    desde o inicio.
  - Periodo anterior via getPreviousPeriodRange; join de nome e cor de categoria
    em memoria com listCategories().
  - transfer fora de Entradas, Saidas e Saldo; categoryId nulo vira
    "Sem categoria".
- Definicao de pronto:
  - Entradas menos Saidas igual a Saldo para qualquer combinacao dos tres tipos.

10. MKTFLX-009 - Testes do dominio
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: MKTFLX-007, MKTFLX-008
- Escopo:
  - entries-service.test.ts no padrao do repo (vi.hoisted + vi.mock, assercoes
    sobre toISOString, nunca getDate).
  - Casos: fronteira de dia em Brasilia (03:00:00.000Z e 02:59:59.999Z); filtro
    parcial com so startDate; virada de dia UTC vs Brasilia; transfer; categoryId
    nulo; soft delete e status sempre no where; paginacao na ultima pagina, alem
    do total e com total zero; distincao "sem base" vs "base zero".
- Definicao de pronto:
  - Cada caso de borda com um `it` nomeado; suite verde com TZ=UTC e sem
    DATABASE_URL.

### Fase 4 - Tela nova em /fluxo-de-caixa

11. MKTFLX-010 - Shell da pagina e formulario de filtros
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: MKTFLX-006
- Escopo:
  - page.tsx como Server Component com dynamic force-dynamic, partindo do layout
    da tela de marketplaces.
  - Presets como links e form GET com data inicial, data final, categoria e tipo.
  - Sem ExportControls, sem filtro de marketplace, sem forma de pagamento, sem
    DataFreshnessNotice.
  - Invariante a comentar: a tela nao aceita as querystrings marketplace nem
    paymentMethod, e o que faz o redirect condicional funcionar.
- Definicao de pronto:
  - Filtros sobrevivem a recarregamento pela querystring; nenhum import de
    read-model na pagina.

12. MKTFLX-011 - Cards de KPI com comparativo
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-008, MKTFLX-010
- Escopo:
  - Entradas, Saidas e Saldo liquido, com delta vs periodo anterior e cor
    invertida em Saidas. Saldo negativo com formatacao propria.
  - Sem base de comparacao mostra "sem base", nunca travessao verde.
- Definicao de pronto:
  - Os tres cards batem com a soma manual dos lancamentos de controle em banco
    real.

13. MKTFLX-012 - Tabela paginada de lancamentos
- Prioridade: P0
- Estimativa: 1 dia
- Dependencias: MKTFLX-007, MKTFLX-010
- Escopo:
  - Server Component, sem seletor de colunas e portanto sem localStorage.
  - Colunas Data, Tipo, Categoria, Descricao, Origem (formatOriginLabel, que ja
    tem manual e import) e Valor; tfoot com total da pagina.
  - Paginacao por link preservando todos os filtros; seletor de linhas por
    pagina. Sem CRUD -- link "Editar em /lancamentos".
- Definicao de pronto:
  - Ultima pagina sem "Proxima"; `?page=999` mostra vazio, nao erro.

14. MKTFLX-013 - Quebra por categoria
- Prioridade: P1
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-008, MKTFLX-010
- Escopo:
  - Total, contagem e percentual por categoria, separando entrada e saida, com a
    cor da categoria.
  - Ordenacao determinista: total desc, nome como desempate. "Sem categoria"
    sempre por ultimo.
- Definicao de pronto:
  - Soma dos totais por categoria igual a Entradas mais Saidas do periodo.

15. MKTFLX-014 - Estados vazio e de erro, e redirect condicional
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-011, MKTFLX-012, MKTFLX-013
- Escopo:
  - Estado vazio com chamada para /lancamentos, em ramo separado do erro de
    banco (aviso ambar + logError("cash_flow_entries_failed")).
  - Substituir o redirect incondicional pelas duas regras `has` em next.config.ts.
  - Reintroduzir "Fluxo de Caixa" no menu, ao lado de "Marketplaces".
  - callbackUrl e router.push de alterar-senha/page.tsx (60 e 70) para /dashboard.
  - As tres ultimas entregas nao podem ser separadas em commits distintos:
    separar produziria 404 ou tela inalcancavel.
- Definicao de pronto:
  - Com DATABASE_URL invalida a tela mostra o aviso e registra log, e nao
    renderiza zeros; `/fluxo-de-caixa` puro serve a tela nova e
    `/fluxo-de-caixa?marketplace=shopify` redireciona com a query intacta.

### Fase 5 - Isolamento, verificacao e docs

16. MKTFLX-015 - Testes de regressao de isolamento
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-007, MKTFLX-012
- Escopo:
  - Lado novo: vi.mock de @/features/transactions/read-model e de pg que lancam
    se chamados. Caso de contaminacao: linha source webhook injetada pelo
    repositorio falso e descartada pelo agregador.
  - Lado Marketplaces: estender read-model.test.ts provando que
    listMarketplaceReadModelPaginated nao devolve linha manual/import nem expense.
- Definicao de pronto:
  - Remover o filtro de origem de qualquer um dos dois lados faz um teste falhar.

17. MKTFLX-016 - Verificacao manual em ambiente real
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-014, MKTFLX-015
- Escopo:
  - Executar os 12 passos do roteiro do plano com npm run dev e banco real,
    incluindo a criacao dos 4 lancamentos de controle.
  - Registrar evidencia (valores anotados vs exibidos) no PR.
- Definicao de pronto:
  - Os 12 passos com resultado registrado e nenhum desvio aberto.

18. MKTFLX-017 - Documentacao de feature e referencias
- Prioridade: P2
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-016
- Escopo:
  - docs/features/feature-cash-flow.md separado em Marketplaces e Lancamentos,
    com o criterio de status, a diferenca deliberada em relacao a /lancamentos e
    a ausencia de aviso de frescor na tela nova.
  - docs/architecture/CONTEXT-TREE.md com as rotas novas.
  - Data-alvo de remocao das regras `has` anotada no next.config.ts.
  - Atualizar as mencoes a /fluxo-de-caixa que passaram a significar Marketplaces
    nos comentarios de shopify-value-verification.ts e
    shopify-payment-resolution-repository.ts.
- Definicao de pronto:
  - Nenhuma referencia em docs ou comentarios usa /fluxo-de-caixa para designar a
    tela de marketplaces.

19. MKTFLX-018 - Gate e PR
- Prioridade: P0
- Estimativa: 0.5 dia
- Dependencias: MKTFLX-017
- Escopo:
  - Rodar os 6 passos localmente e confirmar o CI em Node 20, na branch `dev`.
  - Revisao de diff atras de link ou string /fluxo-de-caixa remanescente com o
    sentido antigo.
- Definicao de pronto:
  - CI verde nos 6 passos, com evidencia da verificacao manual anexada ao PR.
  - `main` sem nenhum commit deste trabalho.

## Marcos (Milestones)
1. M1 - Base pronta: dev sincronizada, gate verde, plano registrado
   (MKTFLX-000 e MKTFLX-001)
2. M2 - Marketplaces vivo em /marketplaces, sem rota orfa nem regressao de auth
   (MKTFLX-002 a MKTFLX-005)
3. M3 - Dominio de lancamentos funcional e isolado do mirror
   (MKTFLX-006 a MKTFLX-009)
4. M4 - Tela nova de /fluxo-de-caixa completa (MKTFLX-010 a MKTFLX-014)
5. M5 - Isolamento provado, verificado em ambiente real e documentado
   (MKTFLX-015 a MKTFLX-018)

## Ordem sugerida de execucao (critica)
1. MKTFLX-000
2. MKTFLX-001
3. MKTFLX-002
4. MKTFLX-003
5. MKTFLX-004
6. MKTFLX-006
7. MKTFLX-007
8. MKTFLX-008
9. MKTFLX-009
10. MKTFLX-010
11. MKTFLX-011
12. MKTFLX-012
13. MKTFLX-013
14. MKTFLX-014
15. MKTFLX-005
16. MKTFLX-015
17. MKTFLX-016
18. MKTFLX-017
19. MKTFLX-018

Racional: MKTFLX-004 sobe cedo porque rota autenticada sem entrada no matcher do
proxy e o unico defeito desta lista com consequencia de seguranca. Os testes de
cada camada entram logo apos a camada, nao no fim -- e a forma de nao descobrir
que o agregador esta errado depois da UI ja estar construida em cima dele.
MKTFLX-005 desce porque a migracao da chave de localStorage e mais facil de
acertar com a tela ja estavel.

## Esforco estimado total
- Faixa: 10 a 13 dias uteis (1 engenheiro), soma nominal dos tickets 12 dias.
- O piso de 10 assume que a tela nova reaproveita bem o layout da tela de
  marketplaces: cards, form GET e paginacao por querystring ja existem prontos
  para copiar.
- O teto de 13 cobre retrabalho de paridade numerica descoberto na verificacao
  manual (MKTFLX-016) e ajuste de UI apos revisao.
- FORA da conta: promocao dev para main e janela de deploy; migracao ou backfill
  de dados (nao ha); qualquer mudanca no Dashboard; qualquer mudanca no CRUD de
  /lancamentos; export na tela nova; indice composto no Postgres; introducao de
  Testing Library (+1,5 a 2 dias) ou Playwright (+3 a 4 dias); janela de
  observacao pos-deploy.

## Riscos de agenda
1. dev estava 52 commits atras de main. Se a sincronizacao fosse recusada, o
   trabalho nao seria orcavel nesta faixa -- exigiria reimplementar as correcoes
   de fuso e a camada de read model. Endereçado por MKTFLX-000, que e ff-only e
   nao reescreve historico.
2. Paridade numerica so aparece na verificacao manual, no fim da fila; um desvio
   reabre a Fase 3 e custa 1 a 2 dias. Mitigacao parcial: conferir os KPIs contra
   os lancamentos de controle ja em MKTFLX-011.
3. Dependencia de banco real com volume representativo de manual e import. Se o
   ambiente so tiver dado de marketplace, a validacao da tela nova fica bloqueada
   ate alguem semear lancamentos.
4. Tres decisoes de produto em aberto: tratamento de transfer, inclusao de
   pending, e se a quebra por categoria separa entrada de saida. Cada uma
   invertida depois da Fase 4 custa 0,5 dia. Fechar as tres por escrito antes de
   iniciar MKTFLX-008.
5. Marketplaces e a tela mais usada; o rename tem janela de risco de link
   quebrado para quem tem bookmark. MKTFLX-004 cobre, mas depende de o redirect
   entrar no mesmo deploy do rename.
6. npm run check inclui build: falha de build de Server Component so aparece no
   fim do ciclo, nao no watch de teste.

## Gate de encerramento
- docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md com todas as fases marcadas
  Concluida e a data do Status de execucao atualizada.
- npm run check verde localmente e no CI (Node 20), na branch dev, nos 6 passos.
- Os 12 passos do roteiro manual executados contra banco real, com os valores
  anotados batendo com os exibidos, registrados no PR.
- `grep -rn "fluxo-de-caixa" src/` retorna apenas a rota da tela nova, o redirect
  e as entradas correspondentes em src/proxy.ts.
- Todos os casos de borda da Fase 3 com `it` nomeado e verde.
- Remover o filtro de origem de qualquer uma das duas telas faz pelo menos um
  teste falhar (verificado uma vez, revertendo em seguida).
- Dashboard com os mesmos numeros e o mesmo aviso de frescor de antes da mudanca,
  comparados lado a lado.
- Zero ocorrencia de marketplaces_entries_failed nas 24 h seguintes ao deploy.
- main sem nenhum commit deste trabalho ate a promocao ser decidida em separado.
