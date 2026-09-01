# Diagnóstico de paridade Shopify — medição de 2026-08-18

> **Status:** Fases 0, 1 e 2 **concluídas** (2026-09-01). Decisão mantida: **não construir o
> ledger transacional** `shopify_payment_transactions` — o grão (pedido, gateway) bastou.
> Ver [Medição de 30/08](#medição-de-3008-o-rateio-sozinho-não-fechava) para o que a Fase 0
> original não tinha como enxergar.
>
> Este documento **sobrepõe** a recomendação de data warehouse de
> [shopify/shopify-payments-by-gateway.md](shopify/shopify-payments-by-gateway.md#data-warehouse)
> para o escopo de faturamento bruto. A metodologia daquele documento continua válida; o que muda
> é o veredito sobre construir a tabela de transações.

## A pergunta

*O dedup é a melhor solução para conciliar os dados do sistema com o faturamento (vendas) na
Shopify?*

Resposta curta: **o dedup é necessário, mas não é a solução de conciliação — e a conciliação
precisa muito menos do que parecia.**

O dedup (`dedupeMirrorRows` em [read-model.ts](../src/features/transactions/read-model.ts))
corrige um defeito de **grão de armazenamento**: `mirror.raw_payloads` guarda uma linha por
evento, não por pedido. Sem ele o faturamento quase dobra. Já o relatório de pagamentos da
Shopify vive no grão **transação**, datado por `transaction.processed_at`. São problemas
diferentes, e a hipótese inicial era que fechar o segundo exigiria um ledger transacional.

A medição mostrou que não exige.

## Escopo declarado da métrica

Definido pelo usuário antes da medição:

- **Alvo:** bruto por gateway/dia, em paridade com `gross_payments` da Shopify por gateway,
  datado por `transaction.processed_at`, com rateio de split exato.
- **Fora de escopo nesta fase:** reembolso e líquido.

## Como foi medido

- **Janela:** 2026-08-01 a 2026-08-11 (11 dias), por `payload.created_at` em `America/Bahia`.
- **Universo:** 30.336 pedidos distintos no mirror; 27.061 pagos, somando **R$ 4.233.339,62**.
- **Método:** apenas `SELECT` read-only no CORE e no OMS. **Zero chamada à Admin API.**
- **Reprodução:** [scripts/sql/diagnostico-paridade-shopify-2026-08.sql](../scripts/sql/diagnostico-paridade-shopify-2026-08.sql).

### Por que nenhuma chamada de API foi necessária

O plano original previa 3 datas × N chamadas REST (~30 mil chamadas). Ficou desnecessário:
`integration.shopify_order_payment_resolution` (`spr`) **já persiste** `total_amount_cents` — a
soma das transações reais da Shopify, buscada via API pelo job de resolução de gateway, com
cobertura de 100% dos pedidos resolvidos e 88-92% com gateway (os ~10% sem gateway são
exatamente os `pending`).

Comparar contra `spr` **é** comparar contra ground truth, e cobre 11 dias inteiros em vez de 3
datas amostradas.

O que `spr` **não** responde é completude — pedidos que existem na Shopify e em lugar nenhum
nosso. Para isso bastaria uma chamada GraphQL paginada (`tenderTransactions`) por dia,
comparando contagens. Não foi feita (ver Fase 4).

## Os modos de falha, quantificados

| Modo de falha | Medida exata | Veredito |
|---|---|---|
| Amplificação de evento (o que o dedup resolve) | **1,90 eventos por pedido**, estável em todos os dias | Dedup é indispensável |
| Valor (`total_price` vs soma real das transações) | 27.030 de 27.033 pedidos **idênticos ao centavo**; 3 pedidos subestimam R$ 493,84. Total: **R$ 493,85 em R$ 4,23M = 0,012%** | Fonte do valor está correta |
| Base de data | 99,153% mesmo dia · 0,770% com data de pagamento diferente da criação, **e o sistema já data pela transação** · **0,077%** (28 pedidos, R$ 3.249,13) sem data de transação, caindo em `created_at` | **Já resolvido** pelo job de resolução |
| Rateio de split — total | **R$ 12.448,78 / R$ 4.230.584,34 = 0,294%** (363 pedidos com dinheiro em mais de um gateway) | Faixa intermediária |
| Rateio de split — por gateway | Pix **+0,17%** · Appmax **+0,16%** · `shopify_store_credit` **+11,58%** (R$ 5.572,98 sobre R$ 48.134,95) · `manual` 0,00% | **Acima de 1% em um gateway individual** |
| `partially_paid` (excluído do financeiro hoje) | **1 pedido** em 30.336, R$ 57,97 | Irrelevante |
| Reembolso | **Zero.** Nenhuma linha do mirror tem `refunded` nem `partially_refunded` | Estruturalmente invisível — ver abaixo |

Contra o critério de decisão definido antes da medição (`< 0,1%` = sobre-engenharia;
`0,1%–1%` = fase separada; `> 1%` em gateway individual = prioridade alta): o total cai na faixa
intermediária, e `shopify_store_credit` estoura o limite de 1%.

### Por que reembolso é zero

O mirror recebe **exatamente dois `event_type`**: `orders/create` (32.533 linhas) e `orders/paid`
(29.390 linhas). Nada mais — não há `orders/updated`, `refunds/create` nem `orders/cancelled`.

Isso explica de uma vez:

- o fator de 1,90 eventos/pedido (create + paid);
- por que a regra "pago vence recência" do dedup funciona tão bem (só existem dois estados);
- e por que reembolso não aparece.

Consequência importante: o dedup **não está escondendo** reembolsos — eles nunca entram no
pipeline. E um ledger transacional derivado do mirror **também não os veria**. Enxergar reembolso
exige uma fonte independente do mirror (`tenderTransactions`) ou a ingestão de mais tópicos de
webhook. Não é um problema de dedup nem de materialização.

## Por que o ledger transacional não se justifica

`resolveDominantPaymentMethod`
([shopify-order-transactions.ts:92-107](../src/features/integration/shopify-order-transactions.ts#L92-L107))
**já constrói** `Map<gateway, { amountCents, processedAt }>` com o rateio completo do pedido — e
descarta tudo menos o vencedor.

Persistir esse mapa corrige **100% do erro medido** (os 0,294% totais e os 11,58% de crédito em
loja):

- sem tabela de transações;
- sem uma única chamada extra de Admin API;
- sem mudar o grão de nenhuma leitura;
- sem tocar `dedupeMirrorRows`.

O ledger completo só se justificaria para **reembolso/líquido**, que está (a) fora do escopo
declarado e (b) bloqueado a montante pelos dois únicos tópicos de webhook que chegam ao mirror.
Construí-lo agora seria pagar por uma capacidade que o pipeline atual não consegue alimentar.

## Limitação honesta da medição

`spr` guarda apenas o gateway **dominante**, não o perdedor. Logo:

- Sei exatamente quanto cada gateway titular recebe **indevidamente**: R$ 12.448,78 no total.
- **Não** sei quanto cada gateway **deixa de receber**.

Como crédito em loja é tipicamente o pagador parcial, é provável que boa parte dos R$ 6.875,80 de
excesso de Pix + Appmax pertença a `store_credit` — o que **reduziria, ou até inverteria**, o erro
líquido de +11,58% na linha dele. Resolver isso custa **uma única data** de detalhe transacional
(Fase 3).

## Fases

| Fase | Escopo | Status |
|---|---|---|
| 0 | Medir cada modo de falha em pedidos e R$, sem escrever nada | **CONCLUÍDA** (2026-08-18) |
| 1 | Persistir o rateio por gateway que o job já calcula e descarta | **CONCLUÍDA** (2026-09-01) — ver [medição de 30/08](#medição-de-3008-o-rateio-sozinho-não-fechava) |
| 2 | Rotular as telas: "Pedidos pagos" vs "Pagamentos processados" | **CONCLUÍDA** (2026-09-01) |
| 3 | Uma data de detalhe transacional, para fechar a direção do erro líquido de `store_credit` | **DISPENSADA** — a medição de 30/08 respondeu sem custo extra: o rateio fecha o crédito na loja ao centavo |
| 4 | Completude via `tenderTransactions` (1 chamada GraphQL/dia): pedidos que existem na Shopify e em lugar nenhum nosso | **DESCARTADA COMO DESENHADA** — `tenderTransactions` é provadamente incompleto (ver abaixo) |
| 5 | Reembolso e líquido | **BLOQUEADA A MONTANTE** — exige decidir ingerir mais tópicos de webhook |

## Medição de 30/08: o rateio sozinho não fechava

Medido em 2026-09-01 com `scripts/diagnostico-pagamentos-shopify-dia.ts` (somente leitura),
contra o relatório "Pagamentos brutos por gateway" da própria Shopify para 2026-08-30.

| Gateway | Sistema (pedidos) | Shopify (pagamentos) | Δ |
|---|---:|---:|---:|
| Pix (3% de desconto) | 677 · R$ 96.166,93 | 682 · R$ 96.200,77 | −R$ 33,84 |
| Appmax - Cartão de Crédito | 431 · R$ 79.517,29 | 439 · R$ 82.081,08 | −R$ 2.563,79 |
| Crédito na loja | 19 · R$ 3.241,66 | 22 · R$ 3.050,96 | **+R$ 190,70** |
| **Total** | **1.127 · R$ 178.925,88** | **1.143 · R$ 181.332,81** | −R$ 2.406,93 |

Três conclusões que mudaram o desenho da Fase 1:

**1. O rateio explica no máximo 20% da diferença.** O dinheiro fora do gateway titular no dia
inteiro é de **R$ 491,36**, em apenas **13 pedidos**. Ele fecha o crédito na loja ao centavo
(R$ 2.952,38 como titular + R$ 98,58 espalhado = **R$ 3.050,96**, exatamente o relatório) e
responde a *Limitação honesta* acima — o erro de `store_credit` de fato se inverte. Mas não toca
os R$ 2.563,79 do cartão.

**2. Os R$ 2.303,43 que faltavam eram materialização atrasada, não rateio.** Dois pedidos Appmax
(`7530846552289` R$ 1.917,42 e `7530888986849` R$ 386,01), criados em 30/08 às 19:09 e 19:40 BRT,
tiveram o `orders/paid` chegando ao mirror só em **31/08 às 18:48 e 19:08 BRT** — depois do último
passe de materialização do dia. Existiam na Shopify e no mirror, mas não em
`integration.financial_orders`. **É por isso que a leitura passou a ser por janela sobre o ledger,
e não por pedido materializado**: o ledger os enxerga, a via antiga não.

**3. `tenderTransactions` não serve como conjunto candidato.** Ele não emite entrada para pedido
pago inteiramente com crédito na loja: por essa via aparecem 13 pagamentos de crédito na loja
(R$ 1.534,16) contra os 22 (R$ 3.050,96) reais. Era **essa** a causa de
`scripts/verify-shopify-values.ts` ler baixo todo dia (R$ 177.512,58 contra R$ 181.332,81), e não
o fuso da janela — a hipótese do fuso foi testada e descartada (1.121 candidatos na janela real
contra os 1.119 que o script lia). A verificação passou a unir `tenderTransactions` com os pedidos
do mirror, e a comparar **por gateway**, não só o total: em 30/08 o crédito na loja estava acima e
o cartão abaixo, e no total as duas divergências se cancelavam parcialmente.

### O que ficou implementado

- `integration.shopify_order_payment_gateway_split` cobre **todos** os pedidos resolvidos (não só
  os com ≥2 gateways) e carrega `transaction_count` — a métrica "Transações" da Shopify conta
  eventos de pagamento, não pedidos.
- O Fluxo de Caixa lê a Shopify por janela sobre `transaction_processed_at` de cada perna.
- A troca de base fica atrás de `FINANCIAL_SHOPIFY_PAYMENTS_BASIS`, **desligada por omissão**: o
  ledger só cobre datas já processadas por `scripts/backfill-shopify-gateway-split.ts`, e ler uma
  janela sem cobertura exibiria a Shopify a menos.
- `CashFlowBySource.basis` diz em que base cada linha foi medida, e a tela rotula as duas.

### Fase 1 — desenho pretendido (não implementado)

Registrado para não se perder, **sem** compromisso de forma:

- O job de resolução ([shopify-payment-resolution-job.ts](../src/features/integration/shopify-payment-resolution-job.ts))
  passa a persistir o mapa por gateway, não só o agregado dominante.
- Padrão do repositório para DDL: `ensure...Table()` em runtime + DDL de referência em
  `scripts/sql/` — **não** `prisma/migrations/`. O deploy roda `prisma generate && next build`,
  sem `migrate deploy`, e uma migration para tabelas ausentes de `schema.prisma` dispara
  drift/reset.
- A leitura por gateway passa a somar o rateio; o total do dia não muda (a soma dos rateios é o
  mesmo `total_amount_cents`).
- `dedupeMirrorRows` não é tocado.

### Fase 2 — o rótulo é obrigatório de qualquer forma

Com reembolso estruturalmente invisível, o número exibido é **bruto de pedidos pagos**, e isso
precisa estar escrito na tela. A prescrição já existe em
[shopify-payments-by-gateway.md](shopify/shopify-payments-by-gateway.md#limitações-atuais):

```txt
Pedidos pagos no OMS
Pagamentos processados na Shopify
```

"Transações" no Fluxo de Caixa é **contagem de pedidos**, não de eventos de pagamento — a Shopify
conta eventos. Não comparar contra a métrica `transactions` do relatório ShopifyQL.

## Achado operacional que atropela a prioridade

A medição encontrou, de passagem, algo três ordens de magnitude maior que o erro de rateio:

**R$ 3.345.430,12 em 23.811 pedidos pagos (12/08 a 18/08) estão no OMS e não estão no CORE
mirror** — 79% do faturamento dos 11 dias analisados, ausente do sistema.

Registrado como pendência operacional em
[PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md](PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md#pendencias-operacionais-fora-do-plano),
que é onde o assunto pertence. Nenhuma correção de rateio de gateway tem sentido antes disso: é
R$ 3,3M ausentes contra R$ 12,4k mal atribuídos.

## Nota de método

O `mirror.raw_payloads` tem **748.958 linhas e 2754 MB** (catálogo, 2026-08-18) — a menção a
"~1,4M linhas" no plano de consumo está desatualizada. Cada consulta desta medição levou 5-18s
com o pool de 2 conexões; medir com `DISTINCT ON` em SQL foi viável aqui porque nada mais estava
rodando (produção congelada), mas continua **não** sendo viável dentro de `computeCashFlow` sob
carga concorrente — foi exatamente o que causou timeout e queda de conexão em 2026-07-26.
