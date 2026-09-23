# Feature: Cash Flow

## Objetivo
Consolidar entradas, saidas e saldo liquido por periodo.

## Entradas
- Receitas de vendas (integracao externa)
- Receitas manuais

## Saidas
- Comissoes e fiscal
- Despesas operacionais
- Pagamentos a influenciadores

## Criterios
- Filtros por periodo, categoria e origem
- Comparativo com periodo anterior
- Estados de loading, erro e vazio

## Tela Marketplaces (`/marketplaces`)
A tela que lista as vendas de marketplace saiu de `/fluxo-de-caixa` para `/marketplaces`
(Fase 2 de docs/PLAN-SEPARACAO-MARKETPLACES-FLUXO-CAIXA.md). Le so a tabela materializada
`integration.financial_orders`, via `computeCashFlow` e `listMarketplaceReadModelPaginated`.

- Uma aba por marketplace, mais "Todos". A aba e o `?marketplace=` da URL: recarregavel,
  compartilhavel e aceita pelo export. Trocar de aba preserva periodo, datas, forma de
  pagamento e linhas por pagina, e volta para a pagina 1.
- As abas saem de `MARKETPLACE_TABS` em `src/features/transactions/marketplace-catalog.ts`.
  **Adicionar um marketplace e acrescentar uma linha ali.** A `key` e o `marketplace_key`
  gravado (ex.: `amazon_global_api`, nao `amazon`); o filtro do repositorio ja e generico, e o
  rotulo do catalogo passa a valer tambem no "Por origem", na tabela e nos cards do Dashboard.
- Anymarket nao tem aba: e hub de integracao, e seus pedidos aparecem nas abas dos
  marketplaces de destino. `?marketplace=anymarket` ou valor desconhecido cai na aba Shopify
  (default); `?marketplace=amazon` resolve para a aba Amazon.
- Links antigos (`/fluxo-de-caixa?marketplace=...` ou `?paymentMethod=...`) redirecionam
  para `/marketplaces` com a query intacta. O redirect e condicional (regras `has`, decisao
  D2 do plano), porque `/fluxo-de-caixa` agora serve a tela nova; remocao prevista para
  23/12/2026.
- Export: aba da planilha "Marketplaces" e arquivo `marketplaces-<stamp>`. A preferencia de
  colunas migra da chave `fluxo-de-caixa-visible-columns` para `marketplaces-visible-columns`.

## Tela Fluxo de Caixa (`/fluxo-de-caixa`)
Tela nova, somente leitura, alimentada **so** pelos lancamentos cadastrados em `/lancamentos`
(Fases 3 e 4 do plano). Servico `computeCashFlowEntries` (`src/features/cash-flow/entries-service.ts`)
sobre um repositorio Prisma-only (`entries-repository.ts`).

- Recorte fixo em `buildEntriesWhere`: `deletedAt IS NULL`, `source IN ('manual','import')`,
  `status IN ('approved','applied')`. O modulo nao importa o read model nem `pg`, e um teste
  quebra se passar a importar: venda de marketplace nao tem caminho ate esta tela.
- **Diferenca deliberada em relacao a `/lancamentos`**, que lista todos os status: aqui
  pendente nao conta. O subtitulo da tela diz isso.
- `transfer` nao entra em Entradas, Saidas nem Saldo; aparece na tabela e num contador.
- Quebra por categoria separada em entrada e saida; "Sem categoria" sempre por ultimo;
  categoria removida com lancamento continua no total.
- Periodo anterior sem nenhum lancamento e "sem base de comparacao", nunca `+0,0%`.
- Sem aviso de frescor: o piso e a defasagem descrevem o mirror, nao `FinancialTransaction`.
- Erro de banco mostra aviso e registra `cash_flow_entries_failed`; vazio e outro ramo.
- A pagina nao aceita `marketplace` nem `paymentMethod`: essas querystrings redirecionam
  para `/marketplaces` (links antigos), ver next.config.ts.
