# Feature: Read Model do Mirror (ALP-CORE-FIN)

## Objetivo
Documentar o mapeamento de campos usado por
`src/features/transactions/read-model.ts` para projetar
`mirror.raw_payloads.payload_json` em colunas de exibição do financeiro
(Dashboard, Fluxo de Caixa, Transações), já que o `payload_json` não tem
contrato único entre marketplaces.

## Contexto
`mirror.raw_payloads` recebe pedidos de dois adaptadores (`source`):
- `anymarket`: cobre Mercado Livre, Amazon e outros canais suportados pelo
  AnyMarket.
- `shopify`: pedidos da loja Shopify.
- `gatea-test-updated` e afins: registros técnicos de teste — não fazem parte
  do domínio financeiro e devem ser filtrados fora do read model e das
  métricas.

`source` identifica o adaptador/origem de ingestão; `marketplace` é o
atributo de negócio exibido no financeiro. Eles são conceitos distintos.

As colunas de exibição desejadas são: Market Place, Número do Pedido, Data,
Forma de Pagamento, Entrega, Descontos, Taxas, Valor.

## Source `anymarket`

Mapeamento recomendado:
- Market Place: derivar de `payload_json.marketPlace` (não fixo — pode ser
  Mercado Livre, Amazon e outros; o read model deve aceitar novos valores sem
  alterar a UI).
- Número do Pedido: `payload_json.marketPlaceNumber`
- Data: `COALESCE(payload_json.paymentDate, payload_json.createdAt, payload_json.lastUpdate)`
  — `paymentDate` pode faltar, por isso o fallback é obrigatório.
- Forma de Pagamento: priorizar `payload_json.payments[0].paymentMethodNormalized`,
  fallback para `paymentDetailNormalized`, depois `method`
- Entrega: `payload_json.freight`
- Descontos: `payload_json.discount`
- Taxas: soma de `payload_json.payments[*].marketplaceFee + gatewayFee`
- Valor: `payload_json.total` (preferir a `total` sobre `gross` para exibição
  consolidada)

## Source `shopify`

Mapeamento recomendado:
- Market Place: valor fixo `Shopify` — não usar `payload_json.source_name`
  sozinho como coluna de Market Place (retorna `web` na amostra real, não
  `shopify`). `source_name` pode ser mantido só como canal secundário.
- Número do Pedido: priorizar `payload_json.name`, fallback para `order_number`
- Data: `COALESCE(payload_json.processed_at, payload_json.created_at, payload_json.updated_at)`
- Forma de Pagamento: concatenar `payload_json.payment_gateway_names[]`;
  suportar composição em pedidos com múltiplos gateways, não apenas o
  primeiro item do array. Fallback complementar em `note_attributes` com
  `_payment_method`.
- Entrega: `payload_json.total_shipping_price_set.shop_money.amount`,
  fallback para `current_shipping_price_set.shop_money.amount`
- Descontos: `payload_json.current_total_discounts_set.shop_money.amount`,
  fallback para `total_discounts`
- Taxas: somar `payload_json.current_total_additional_fees_set.shop_money.amount`
  (pode vir `null` — tratar como zero) com
  `payload_json.current_total_tax_set.shop_money.amount`
- Valor: `payload_json.total_price`, fallback para `current_total_price`

Para o gateway titular correto em pedidos Shopify com pagamento dividido
(split), ver [shopify-payments-by-gateway.md](../shopify/shopify-payments-by-gateway.md)
e o job `src/features/integration/shopify-payment-resolution-job.ts`, que
alimenta este read model via LEFT JOIN.

## A Shopify pode não vir daqui

Com `FINANCIAL_SHOPIFY_PAYMENTS_BASIS=true`, a linha Shopify do Fluxo de Caixa
**não** sai de `integration.financial_orders`. Ela sai do ledger de rateio
`integration.shopify_order_payment_gateway_split`, somado por janela sobre o
`transaction_processed_at` de cada perna do pagamento — que é como a Shopify
monta o relatório "Pagamentos brutos por gateway".

Duas consequências que valem lembrar antes de investigar uma divergência:

- A linha Shopify passa a incluir pagamento de pedido que ainda não foi
  materializado (medido em 30/08/2026: R$ 2.303,43 em dois pedidos cujo
  `orders/paid` chegou depois do último passe do dia). Divergência entre a
  tela e `financial_orders` deixa de ser, por si só, sinal de defeito.
- `transactionCount` da Shopify passa a contar **transações**, e as demais
  origens continuam contando **pedidos**. `CashFlowBySource.basis` diz qual é
  qual, e a tela rotula as duas. Não são somáveis entre si.

O ledger só cobre datas já processadas por `npm run backfill:shopify-split`.
Janela sem cobertura cai automaticamente na base de pedidos, em vez de exibir
zero. Ver [DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md](../DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md).

## Source `gatea-test-updated` (e outros registros técnicos)
Não fazem parte do domínio financeiro. Devem ser filtrados para fora da
leitura do front e das métricas de paridade/comparação.
