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
- `/fluxo-de-caixa` redireciona para `/marketplaces` com a query intacta. O redirect e
  temporario e incondicional; quando a tela nova de Fluxo de Caixa entrar, vira as regras
  `has` da decisao D2 do plano.
- Export: aba da planilha "Marketplaces" e arquivo `marketplaces-<stamp>`. A preferencia de
  colunas migra da chave `fluxo-de-caixa-visible-columns` para `marketplaces-visible-columns`.
