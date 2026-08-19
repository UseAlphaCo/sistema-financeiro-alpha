# Shopify Payments por Gateway

Este documento explica como reconciliar venda bruta, reembolsos e pagamento líquido por gateway Shopify no Vision360 OMS, respeitando pedidos com pagamento dividido entre crédito em loja, Pix e Appmax.

> **Nota de 2026-08-18 — a metodologia continua válida; a recomendação de data warehouse não.**
> A divergência entre o sistema e a Shopify foi medida contra 11 dias de dados reais
> (R$ 4,23M em pedidos pagos) e o resultado está em
> [DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md](../DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md).
> Em resumo: o erro de rateio de split é de **0,294%** no total (mas **+11,58%** em
> `shopify_store_credit`), a fonte do valor e a base de data já estão corretas, e a tabela
> `shopify_payment_transactions` recomendada em [Data Warehouse](#data-warehouse) **não será
> construída** para o escopo de faturamento bruto — o rateio completo já é calculado e descartado
> por `resolveDominantPaymentMethod`, e persistí-lo resolve 100% do erro medido. Ler o
> diagnóstico antes de agir sobre este documento.

## Objetivo

Reproduzir o relatório Shopify:

```sql
FROM payments
  SHOW transactions, gross_payments, refunded_payments, net_payments
  WHERE transaction_kind IN ('sale', 'change', 'capture', 'refund')
  GROUP BY payment_gateway WITH TOTALS
  DURING yesterday
  ORDER BY net_payments DESC
  LIMIT 1000
```

O ponto central é que esse relatório é transacional. Ele não conta pedidos; ele soma eventos financeiros por `processed_at`.

## Por Que o Raw Payload Não Basta

O `raw_payloads.payload_json` de pedidos Shopify informa:

- `financial_status`
- `payment_gateway_names`
- `total_price`
- `total_outstanding`
- `refunds`
- datas do pedido

Mas ele normalmente não informa:

- `transactions[]`
- valor pago por gateway em pedido split
- gateway real de cada captura, venda ou reembolso

Exemplo real:

```json
{
  "payment_gateway_names": ["shopify_store_credit", "Pix (3% de desconto)"],
  "total_price": "164.79",
  "transactions": null
}
```

Nesse caso, o raw mostra que houve split, mas não permite saber quanto foi pago em crédito em loja e quanto foi pago em Pix. O valor correto só vem das transações do pedido.

## Fonte de Dados Correta

Use duas fontes:

1. Banco OMS/Supabase para localizar pedidos e preservar auditoria.
2. Shopify Admin API para transações financeiras reais.

### Banco OMS

Tabela:

```txt
raw_payloads
```

Campos usados:

```txt
source
external_order_id
received_at
payload_json
```

Consulta base para localizar pedidos Shopify criados no dia:

```sql
with bounds as (
  select
    ('2026-05-26'::date::timestamp at time zone 'America/Bahia') as starts_at,
    (('2026-05-26'::date + interval '1 day')::timestamp at time zone 'America/Bahia') as ends_at
), latest as (
  select distinct on (rp.external_order_id) rp.*
  from raw_payloads rp, bounds b
  where rp.source = 'shopify'
    and (rp.payload_json->>'created_at')::timestamptz >= b.starts_at
    and (rp.payload_json->>'created_at')::timestamptz < b.ends_at
  order by rp.external_order_id, rp.received_at desc, rp.id desc
)
select
  external_order_id,
  payload_json->>'name' as order_name,
  payload_json->'payment_gateway_names' as payment_gateway_names,
  payload_json->>'financial_status' as financial_status,
  payload_json->>'total_price' as total_price
from latest;
```

Essa consulta ajuda a montar candidatos e comparar a visão OMS, mas não deve ser usada sozinha para o valor final por gateway.

### Shopify Tender Transactions

Use GraphQL para descobrir pedidos com transações no período:

```graphql
query TenderTransactions($first: Int!, $after: String, $query: String!) {
  tenderTransactions(first: $first, after: $after, query: $query) {
    edges {
      node {
        processedAt
        order {
          legacyResourceId
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
```

Query de busca:

```txt
processed_at:>=2026-05-26 processed_at:<=2026-05-27
```

Depois filtre no código pela janela exata em UTC:

```txt
2026-05-26T03:00:00.000Z <= processedAt < 2026-05-27T03:00:00.000Z
```

Para `America/Bahia`, meia-noite local equivale a `03:00:00Z`.

### Shopify Order Transactions

Para cada pedido candidato, buscar:

```http
GET /admin/api/2026-01/orders/{shopify_order_id}/transactions.json
```

Campos usados:

```txt
id
kind
status
gateway
amount
processed_at
parent_id
```

## Regra de Cálculo

Filtro obrigatório:

```ts
processed_at >= startUtc
processed_at < endUtc
kind in ["sale", "capture", "change", "refund"]
status === "success"
```

Acúmulo por gateway:

```ts
if (transaction.kind === "refund") {
  gateway.refunded_payments += Math.abs(amount);
} else {
  gateway.gross_payments += amount;
}

gateway.net_payments = gateway.gross_payments - gateway.refunded_payments;
```

O agrupamento deve usar:

```ts
transaction.gateway
```

Não use:

```ts
payload_json.payment_gateway_names[0]
```

Isso quebra pedidos split.

## Pedido Split

Um pedido pode ter:

```txt
total_price = 164.79
shopify_store_credit = 147.19
Pix = 17.60
```

No raw:

```json
{
  "payment_gateway_names": ["shopify_store_credit", "Pix (3% de desconto)"],
  "total_price": "164.79"
}
```

Nas transações:

```json
[
  {
    "kind": "capture",
    "status": "success",
    "gateway": "shopify_store_credit",
    "amount": "147.19"
  },
  {
    "kind": "sale",
    "status": "success",
    "gateway": "Pix (3% de desconto)",
    "amount": "17.60"
  }
]
```

Somente as transações permitem ratear corretamente.

## Datas: Pedido vs Pagamento

O relatório Shopify `FROM payments DURING yesterday` usa a data da transação, não a data de criação do pedido.

Exemplo:

- Pedido criado em `25/05`.
- Pix pago em `26/05`.
- Entra no relatório de pagamentos de `26/05`.

Outro exemplo:

- Pedido criado em `26/05`.
- Pix pago em `27/05`.
- Não entra no relatório de pagamentos de `26/05`.

Portanto, subsistemas financeiros devem filtrar por:

```txt
transaction.processed_at
```

E não por:

```txt
order.created_at
raw_payload.received_at
payload_json.created_at
```

## Script Operacional

O repositório possui o script:

```txt
scripts/shopify-payments-by-gateway.mjs
```

Comando:

```bash
npm run report:shopify-payments -- --date 2026-05-26
```

JSON:

```bash
npm run report:shopify-payments -- --date 2026-05-26 --json
```

Saída principal:

```json
{
  "shopify_payment_transactions": {
    "by_gateway": [
      {
        "gateway": "Pix (3% de desconto)",
        "gross_payments": "111806.23",
        "refunded_payments": "5223.39",
        "net_payments": "106582.84"
      }
    ]
  }
}
```

## Como Usar em Subsistemas

### Financeiro

Use `gross_payments`, `refunded_payments` e `net_payments` por gateway para conciliação diária.

Não use quantidade de pedidos para fechar relatório Shopify. A métrica da Shopify é `transactions`.

### Dashboard Operacional

Pode exibir:

- venda bruta por gateway
- reembolso por gateway
- líquido por gateway
- diferença entre visão OMS por pedido e visão Shopify por transação

Rotule claramente:

```txt
Pedidos pagos no OMS
Pagamentos processados na Shopify
```

### Data Warehouse

> **SUPERADO para o escopo de faturamento bruto (2026-08-18).** A medição em
> [DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md](../DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md) mostrou que
> esta tabela não se paga: o erro que ela corrigiria é de 0,294% e tem uma correção muito mais
> barata (persistir o mapa por gateway que o job de resolução já monta). O modelo abaixo segue
> sendo o desenho certo **se e quando** reembolso/líquido entrar em escopo — o que hoje está
> bloqueado a montante, porque o mirror recebe apenas os tópicos `orders/create` e `orders/paid`,
> e portanto nenhuma tabela derivada dele veria um reembolso.

Modelo recomendado:

```txt
shopify_payment_transactions
  id
  order_id
  transaction_id
  gateway
  kind
  status
  amount
  currency
  processed_at
  parent_id
  raw_payload_id
  fetched_at
```

Chaves:

```txt
unique(source, transaction_id)
index(processed_at)
index(gateway)
index(order_id)
```

### ERP/Contabilidade

ERP deve consumir o consolidado transacional, não o gateway principal do pedido.

Pedidos split devem gerar múltiplas linhas financeiras se o destino exigir separação por forma de pagamento.

## Limitações Atuais

- O raw payload de pedido não contém `transactions[]`.
- A API ShopifyQL `shopifyqlQuery` exige scope `read_reports`; o token atual pode não ter esse acesso.
- O script reconstrói o relatório usando `tenderTransactions` + `orders/{id}/transactions.json`.
- Para uso recorrente em produção, persistir transações em tabela própria evita chamadas repetidas à Shopify.

## Critério de Validação

A lógica foi validada contra relatório Shopify de `25/05/2026`:

```txt
Pix:               R$ 99.119,18
Appmax:            R$ 71.335,41
Crédito na loja:   R$ 5.771,61
Total:             R$ 176.226,20
```

E contra relatório Shopify de `26/05/2026` para pagamentos brutos:

```txt
Pix:               R$ 111.806,23
Appmax:            R$ 98.458,91
Crédito na loja:   R$ 5.583,65
Total:             R$ 215.848,79
```

## Regra Final

Para venda bruta por gateway Shopify:

```txt
Somar transações Shopify por transaction.gateway,
filtradas por transaction.processed_at,
kind em sale/capture/change/refund,
status success,
com split respeitado pela própria transação.
```

