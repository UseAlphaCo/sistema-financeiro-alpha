# Diagnóstico de paridade Shopify — medições de 18/08, 30/08, 08/09, 09/09 e 20/09

> **Status:** Fases 0, 1 e 2 **concluídas** (2026-09-01). Decisão mantida: **não construir o
> ledger transacional** `shopify_payment_transactions` — o grão (pedido, gateway) bastou.
> Ver [Medição de 30/08](#medição-de-3008-o-rateio-sozinho-não-fechava) para o que a Fase 0
> original não tinha como enxergar, e [Medição de 08/09](#medição-de-0809-a-paridade-de-valor-fechou)
> para o veredito atual: **a paridade de valor fechou** e a defasagem que resta é toda de
> materialização, não de rateio nem de fonte de dado. A
> [medição de 09/09](#medição-de-0909-o-ledger-fecha-com-a-shopify-pedido-a-pedido) confirmou isso
> por uma via independente — o ledger bate com o `tenderTransactions` **pedido a pedido**, desvio
> R$ 0,00 — e corrigiu o tamanho do ponto cego do crédito na loja, que é **por perna de pagamento**,
> não só por pedido pago integralmente assim.
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
| 4 | Completude via `tenderTransactions` (1 chamada GraphQL/dia): pedidos que existem na Shopify e em lugar nenhum nosso | **DESCARTADA COMO DESENHADA, REAPROVEITADA COM ESCOPO MENOR** — `tenderTransactions` é provadamente incompleto (ver abaixo), e a [medição de 08/09](#medição-de-0809-a-paridade-de-valor-fechou) mostrou a incompletude uma segunda vez. Não serve como conjunto candidato; serve como **conferência independente do ledger**, descartando as pernas de crédito na loja — ver [medição de 09/09](#medição-de-0909-o-ledger-fecha-com-a-shopify-pedido-a-pedido) |
| 5 | Reembolso e líquido | **BLOQUEADA A MONTANTE** — exige decidir ingerir mais tópicos de webhook. Ganhou um funil de candidatos: o status `persistente` da reconciliação (2026-09-20) |
| 6 | Reconciliação por pedido: detectar e consertar o rateio com valor velho | **CONCLUÍDA** (2026-09-20) — ver [a seção final](#reconciliação-recorrente-2026-09-20-a-classe-sem-remédio-passa-a-ter-um) |

Encerrado o escopo declarado (bruto por gateway/dia, datado por `transaction.processed_at`): a
[medição de 08/09](#medição-de-0809-a-paridade-de-valor-fechou) fechou dois dos três gateways ao
centavo e explicou o terceiro. O trabalho que resta **não é de paridade** — é defasagem de
materialização e cobertura do ledger antes de 23/08.

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

## Medição de 08/09: a paridade de valor fechou

Medido em 2026-09-08 (somente leitura) sobre **2026-09-07**, o último dia fechado, com
`scripts/diagnostico-pagamentos-shopify-dia.ts` — que rebusca a Admin API em vez de comparar
contra um relatório capturado antes.

| Gateway | Ledger de rateio | Shopify (API, hoje) | Δ |
|---|---:|---:|---:|
| Appmax - Cartão de Crédito | 334 tx · R$ 71.399,33 | 334 tx · R$ 71.399,33 | **R$ 0,00** |
| Pix (3% de desconto) | 449 tx · R$ 71.145,92 | 449 tx · R$ 71.145,92 | **R$ 0,00** |
| Crédito na loja | 20 tx · R$ 1.661,17 | 18 tx · R$ 1.461,25 | +R$ 199,92 |
| **Total** | **803 tx · R$ 144.206,42** | **801 tx · R$ 144.006,50** | +R$ 199,92 |

Dois dos três gateways fecham **ao centavo** — inclusive o Appmax, que em 30/08 aparecia
−R$ 2.563,79 e era a maior divergência aberta. Aquele buraco tinha duas causas somadas, e as duas
se fecharam: R$ 2.303,43 de `orders/paid` que chegou depois do último passe de materialização, e o
resto de capturas que a Shopify só registrou dias depois (ver
[30/08 revisitado](#3008-revisitado-também-fecha-ao-centavo)).

**Os R$ 199,92 são cegueira do instrumento, não erro do sistema.** É um único pedido,
`7551826624737`, pago **inteiramente** com crédito na loja (gateway único, 2 transações,
`spr.total_amount_cents` = R$ 199,92). É exatamente a classe de pedido para a qual
`tenderTransactions` não emite entrada — o achado que já havia descartado a Fase 4. O ledger está
certo; quem não vê é a via de medição.

### O que a tela mostra, e por quê

Com `FINANCIAL_SHOPIFY_PAYMENTS_BASIS` desligada, a base é pedidos (`integration.financial_orders`):
**R$ 141.881,27 / 777 pedidos**, R$ 2.125,23 abaixo (1,50%). O diagnóstico decompôs **100% disso**
em `pedido_nao_materializado` (6 pedidos) e fechou com **`NAO EXPLICADO: R$ 0,00`** — a primeira
medição sem resíduo. Uma consulta SQL independente devolveu os mesmos 6 pedidos e os mesmos
R$ 2.125,23.

Integridade de valor no período coberto pelo ledger (23/08–07/09): `spr.total_amount_cents` contra a
soma das pernas → **0 divergências em 19.237 pedidos, R$ 0,00**.

### A defasagem restante é toda de materialização

Estado em 2026-09-08, 12:44 BRT:

| Dia | Pagos no mirror | Sem materializar |
|---|---:|---:|
| 08/09 (corrente) | 222 | **222 · R$ 42.560,62** |
| 07/09 | 782 | 6 · R$ 2.125,23 |
| 06/09 | 703 | 4 · R$ 1.043,99 |
| 05/09 e anteriores | — | 0 |

A fila de resolução de gateway estava **zerada** em todos esses dias: o ledger já continha
R$ 44.187,55 do dia corrente, com a última perna gravada às 12:26 BRT — **minutos** depois do
pagamento. O dado existe quase em tempo real; o caminho de leitura é que não o usa, porque o passe
D-0 da materialização só roda às 23:00 BRT. É a origem do R$ 0,00 em "Hoje" descrito no docblock de
`getMaterializedLag`
([financial-orders-repository.ts](../src/features/transactions/financial-orders-repository.ts)).

Isso inverte a ordem de prioridade que valia até aqui: **não há mais erro de valor a corrigir na
Shopify; há defasagem de leitura.**

### O ponto cego do crédito na loja é por PERNA, não por pedido

Medido em 09/09 sobre 07/09 e 05/09, ao trocar a verificação diária pelo ledger (ver
[Medição de 09/09](#medição-de-0909-o-ledger-fecha-com-a-shopify-pedido-a-pedido)). Corrige o que
está escrito acima em *3. `tenderTransactions` não serve como conjunto candidato*, que descreve o
ponto cego como restrito a "pedido pago **inteiramente** com crédito na loja".

Não é. Em 07/09, comparando pedido a pedido, **18 dos 786** pedidos divergiam entre o ledger e o
`tenderTransactions`, somando R$ 1.461,25 — e esse valor é **exatamente** a soma das pernas
`shopify_store_credit` desses mesmos 18 pedidos, ao centavo. Todos eles são pedidos **parcialmente**
pagos com crédito: uma perna Pix ou Appmax, que o tender reporta, e uma perna de crédito na loja,
que ele omite.

```
7553206321377  tender=R$  18,31  ledger=R$ 202,31  delta=-R$ 184,00  (= perna shopify_store_credit)
7552157516001  tender=R$  35,22  ledger=R$ 211,51  delta=-R$ 176,29  (= perna shopify_store_credit)
7552072777953  tender=R$  26,32  ledger=R$ 145,65  delta=-R$ 119,33  (= perna shopify_store_credit)
```

Duas consequências, e as duas mudam desenho:

1. **Qualquer detector que compare ledger × tender precisa descartar as pernas de crédito**, senão
   produz ~18 falsos positivos por dia que nunca fecham. Com elas fora, o desvio de 07/09 e 05/09 é
   **R$ 0,00 em 0 pedidos** — o ledger concorda com a Shopify pedido a pedido.
2. **Em nenhum dos 18 o tender apontava MAIS que o ledger.** Zero pedidos na direção que
   significaria dinheiro recebido pela Shopify e não registrado por nós. É o segundo resultado
   independente apontando que o ledger está correto.

### Medição de 09/09: o ledger fecha com a Shopify pedido a pedido

A verificação diária (`/api/internal/cron/shopify-verify`) montava o lado Shopify com **uma chamada
REST por pedido candidato** — ~1.700/dia, serializadas pelo portão de 500 ms do bucket: cerca de
**850 s**, numa rota que era a única das quatro **sem `maxDuration` declarado**. Ela não completava,
e o ramo de alerta nunca executou em produção.

Trocada pelo ledger, com o `tenderTransactions` como terceira ponta: **42 s medidos** na chamada
real, contra os ~850 s anteriores. A verificação passou a dizer *de que lado* está o problema:

| Ponta | Compara | Mede |
|---|---|---|
| 1 | Sistema × Ledger | defasagem de **materialização** (tudo em SQL) |
| 2 | Ledger × `tenderTransactions` | deriva do lado da **Shopify** (~10 chamadas GraphQL) |

Em 07/09 a ponta 2 fecha em **R$ 0,00**. A ponta 1 acusa −R$ 199,92 — o pedido de crédito integral
já documentado acima. Uma consulta SQL sobre 31/08–07/09 mostra que essa lacuna da ponta 1 é
**recorrente, não pontual**: sistema abaixo do ledger em 7 dos 8 dias, entre R$ 84,98 e R$ 469,17
por dia, com 06/09 fechando exatamente em zero. É defasagem de atribuição de janela e de
materialização, e é a ponta 1 fazendo exatamente o que foi desenhada para fazer.

**A Shopify emite tender negativa para reembolso**: 2 entradas em 08/09. O ledger só soma
`sale`/`capture`/`change` e ignora `refund`, então somar as negativas faria todo pedido reembolsado
divergir para sempre contra um ledger que nunca vai concordar. Elas são descartadas e contadas.

### 09/09, 10:50 BRT: a corrente da manhã fecha, e o alerta dispara pela primeira vez

Com a cadência da Fase 3 no ar (sync 10:00 → resolução 10:15 → materialização 10:40 → verificação
10:50), a execução automática de 09/09 sobre 08/09 foi a **primeira com `isMature: true`** desde que
o sinal existe — e portanto a primeira em que o ramo de alerta executou em produção:

| | 08:46 BRT | 09:31 BRT | **10:50 BRT (cron)** |
|---|---:|---:|---:|
| Pedidos sem gateway resolvido | 65 | 0 | **0** |
| Materializados sem perna no ledger | 56 | 0 | **0** |
| `isMature` | falso | — | **verdadeiro** |
| Ponta 1 — bruto Sistema × Ledger | −R$ 1.152,79 | −R$ 1.152,79 | **R$ 0,00** |
| Ponta 2 — desvio Ledger × Shopify | R$ 10.293,27 (60 pedidos) | R$ 679,69 (3) | **R$ 679,69 (3)** |
| `alert` | `informational` | — | **`divergence`** |

Duas leituras que essa tabela obriga:

1. **A lacuna recorrente da ponta 1 era de horário, não de dado.** Ela aparecia em 7 dos 8 dias
   medidos porque a verificação rodava às 06:00 BRT, antes do passe de materialização de fechamento.
   Com a verificação depois das 10:40, o bruto fecha em **R$ 0,00** — os 6 pedidos que faltavam
   entraram no passe das 10:40. A ponta 1 não acusava um defeito de valor; acusava a ordem errada
   dos elos.
2. **Desvio de dia imaturo não é desvio, é fila.** Às 08:46 a ponta 2 leu R$ 10.293,27 em 60
   pedidos; às 09:31, sem ninguém corrigir nada, R$ 679,69 em 3. Os 57 pedidos da diferença nunca
   divergiram — só ainda não tinham perna no ledger. É a razão de o painel exibir o número de um dia
   imaturo como **parcial**, e não como veredito (ver `verification-run-view.ts`).

Sobram os **3 pedidos / R$ 679,69** da ponta 2, que são os únicos candidatos reais da Fase 5 já
observados: em 05/09 e 07/09 esse número foi zero.

### Limites reconfirmados

- **Reembolso e cancelamento seguem estruturalmente invisíveis.** Nos últimos 20 dias o mirror
  recebeu apenas `orders/create` (30.959 linhas) e `orders/paid` (27.280). Nada mais — o quadro de
  2026-08-18 não mudou. O número validado é bruto de pedidos pagos, e isso é da ingestão.
- **O ledger só cobre 2026-08-23 em diante** (`min(transaction_processed_at)` = 31/07, mas contínuo
  só a partir de 23/08). Ligar a base de pagamentos agora não muda nada numa janela de 30 dias: o
  guard de cobertura em [service.ts](../src/features/cash-flow/service.ts) derruba a janela inteira
  para a base de pedidos se faltar um dia. Exige backfill de 01→22/08 antes.
- **`pending` é 15,05% do bruto criado** em 01–07/09 (R$ 219.914,28 em 1.039 pedidos). Fora do
  faturamento por definição correta — registrado porque é o tamanho da fila, não um defeito.

### 30/08 revisitado: também fecha ao centavo

Não exigiu nenhuma chamada nova de API — o ledger em 08/09 pode ser comparado contra o valor
verdadeiro daquele dia, que a medição de 02/09 já havia estabelecido:

| Gateway | Ledger em 08/09 | Verdade do dia | Fonte da verdade |
|---|---:|---:|---|
| Pix (3% de desconto) | 682 · R$ 96.200,77 | 682 · R$ 96.200,77 | relatório de 01/09 |
| Appmax - Cartão de Crédito | 442 · R$ 83.407,80 | 442 · R$ 83.407,80 | API em 02/09 |
| Crédito na loja | 22 · R$ 3.050,96 | 22 · R$ 3.050,96 | rateio, confirmado em 01/09 |
| **Total** | **R$ 182.659,53** | **R$ 182.659,53** | |

Dois pontos que isso comprova:

1. **O relatório lido em 01/09 estava incompleto**, não errado do nosso lado: ele dava Appmax
   439 · R$ 82.081,08. O dia continuou crescendo do lado da Shopify por ~2 dias (capturas Appmax
   atrasadas). Comparar contra um relatório capturado cedo mede a defasagem *deles*.
2. **A perna atrasada foi recolhida — mas nenhum mecanismo automático a recolheu.** Em 02/09 o
   ledger marcava R$ 182.564,56, e a diferença de R$ 94,97 contra a verdade era exatamente uma
   perna Appmax atrasada. Hoje o ledger marca R$ 182.659,53: os R$ 94,97 entraram.

   Vale ser preciso sobre o que pode e o que não pode ter fechado isso, porque é a diferença entre
   uma rotina e um acaso:

   - O **job de resolução** não foi: o predicado dele é
     `spr.external_order_id IS NULL OR rp.mirror_updated_at > spr.resolved_at`, e uma transação
     nova num pedido existente **não** muda `payload_json` nem `mirror_updated_at`.
   - O **backfill** (`scripts/backfill-shopify-gateway-split.ts`) só alcança o caso em que o pedido
     ainda **não tinha nenhuma** linha de rateio: tanto `derivarDeResolucao` quanto
     `carregarPedidosSemRateio` filtram `g.external_order_id IS NULL`. Ele fecha "pedido **sem**
     rateio"; **não** fecha "rateio com valor **velho**". Para um pedido que já tem linha, o único
     caminho é `--ids-file`, que é manual e exige saber de antemão qual pedido mudou.

   Ou seja: os R$ 94,97 pertenciam a um pedido que ainda não tinha rateio nenhum, ou entraram por
   uma lista de ids montada à mão. **A classe "pedido já resolvido que recebeu transação nova" não
   tem remédio automático hoje** — nem o job, nem o backfill, nem o auto-align do `shopify-verify`
   (que chama o mesmo job, com o mesmo predicado, e portanto é no-op por construção para esses
   pedidos). Fechar essa classe exige um detector que compare o ledger contra a Shopify por pedido,
   e é a única capacidade genuinamente nova que a paridade ainda pede.

   > **FECHADO em 2026-09-20** pela reconciliação recorrente — ver
   > [a seção abaixo](#reconciliação-recorrente-2026-09-20-a-classe-sem-remédio-passa-a-ter-um).

## Reconciliação recorrente (2026-09-20): a classe sem remédio passa a ter um

O detector pedido acima existe, e roda dentro da própria verificação diária
([shopify-reconciliation.ts](../src/features/integration/shopify-reconciliation.ts)). **Zero cron
novo, zero invocação a mais**: a rota das 10:50 BRT já buscava o `tenderTransactions` e já
calculava o delta por pedido — só descartava a identidade dos divergentes, guardando contadores.

### O que mudou

| | antes | agora |
|---|---|---|
| Janela | D-1 | **D-1..D-3**, numa única busca paginada (D-4..D-0) |
| Saída do desvio | "3 pedidos / R$ 679,69" | linha por pedido em `integration.shopify_reconciliation_divergences` |
| Conserto | só pedido **sem** resolução | também **rateio com valor velho**, via `resolveShopifyOrderById` |
| Custo da rota | ~42 s | **90 s medidos**, teto de 300 s |

D-1..D-3 e não só D-1 porque a captura atrasada que motiva tudo isto foi observada chegando até
~2 dias depois (as capturas Appmax de 30/08, que a Shopify só registrou em 01-02/09).

### Por que o ciclo fecha sem código novo no caminho de leitura

`upsertShopifyPaymentResolution` grava `resolved_at = NOW()` → `findOrderKeysWithStaleResolution`
seleciona por `resolved_at > materialized_at` → o passo 1b da materialização já consome esse
conjunto. O pedido reconciliado reentra na materialização sozinho.

**Ordem importa:** a reconciliação roda às 10:50, *depois* da materialização das 10:40. A correção
aparece na tela no passe seguinte, não na hora.

### Duas salvaguardas que não são detalhe

1. **Dia imaturo não é reconciliado.** D-1 só entra se `maturity.isMature`; D-2 e D-3 entram
   sempre. Em 09/09 um dia imaturo mostrou 60 pedidos divergentes às 08:46 e 3 às 09:31, sem
   ninguém corrigir nada — reconciliar ali dispararia dezenas de re-resoluções contra uma fila que
   ia drenar sozinha.
2. **As duas exclusões medidas são preservadas** por `detectOrderDivergences`, que é a regra única
   compartilhada entre a verificação e a reconciliação: pernas de crédito na loja (senão ~18 falsos
   positivos/dia) e entradas negativas do tender.

### Status `persistente`

Pedido corrigido que **volta** a divergir. Separa "atrasou e fechou" de defeito estrutural, e vira
o funil de candidatos da Fase 5 — que continua bloqueada a montante, mas agora tem uma lista em vez
de uma suspeita.

### Reconferência (23/09/2026): o placar passa a ser de estado

Até aqui a tabela só tinha uma transição de saída: o conserto da própria rotina (`corrigido`). Uma
divergência resolvida por **outro** caminho (materialização tardia, job de resolução, backfill)
ficava `pendente` para sempre, e o "Em aberto" do painel só crescia, o que tirava dele o sentido de
"aberto agora".

A cada rodada, antes da fila de retentativa, a rotina re-mede contra o ledger **todo** o conjunto
aberto, inclusive o que está em recuo e o `sem_correcao` que já esgotou as tentativas. Quem deixou
de divergir fecha como `fechado_por_reconferencia`:

- **sem chamada à Admin API**, só leitura do ledger (`findLedgerGatewayTotalsByOrderIds` +
  `detectOrderDivergences`, com a mesma tolerância da detecção);
- **sem gastar tentativa** (`attempts` não sobe) e **sem datar correção** (`corrected_at` nulo):
  quem consertou foi outro mecanismo, e somar isso a `corrigido` inflaria a taxa de conserto da
  rotina com trabalho que ela não fez;
- se o pedido voltar a divergir, reabre como `persistente`, igual a um `corrigido`.

Os status abertos (`pendente`, `persistente`, `sem_correcao`) viram estado atual; os fechados
continuam acumulando, porque a falta de retenção segue deliberada. O CLI imprime os dois grupos
separados, e o painel mostra quantas fecharam na reconferência da última rodada.

Medido em 23/09 com dados reais: aplicada aos 22 pedidos já `corrigido`, a regra fecharia os 22, e
o ledger medido bate ao centavo com o `ledger_cents_after` gravado no conserto. A rota completa
(chamada real) rodou em 75 s: 2.142 pedidos comparados, 5 detectados e 5 corrigidos
(R$ 2.174,38), com `reconferred: 0`, já que não havia nada aberto antes da rodada.

### Fila de tratamento na tela (23/09/2026)

A lista por pedido, que só existia no CLI, passou a aparecer em `/integracoes` para admin e
financeiro, com duas ações:

- **Reprocessar:** devolve o pedido para a rodada das 10:50 BRT. Não chama a Shopify na hora. Numa
  linha que já esgotou as tentativas, devolve **uma** tentativa, e não um orçamento novo: só zerar
  `next_attempt_at` não a recolocaria na fila, que filtra `attempts < max`.
- **Aceitar:** fecha como `aceito`, por decisão humana, gravando quem (`accepted_by`), quando e,
  opcionalmente, por quê. Redetecção com o mesmo delta não desfaz o aceite, porque a janela de três
  dias redetectaria a mesma divergência. Delta diferente reabre como `persistente`.

Rota em `/api/financial/integrations/shopify/divergences` (GET a fila; POST em `/<pedido>` com
`{ action }`), com `withApiSecurity` e roles admin e financeiro, fora de `/api/internal`, que é
credencial de máquina. A tela e o CLI leem as mesmas funções (`listOpenDivergences` e
`countDivergencesByStatus`), então contam a mesma coisa. O placar do bloco de reconciliação no
painel continua sendo o do fim da última rodada, e agora diz isso.

### Medições de 20/09/2026

| Medição | Resultado |
|---|---|
| 17-19/09, inspeção sem escrita | **2.386 pedidos comparados, 0 divergências**, 29 s |
| 06-08/09 (onde 09/09 vira 3 pedidos / R$ 679,69) | **2.291 pedidos, 0 divergências** — aqueles 3 fecharam desde então |
| Re-resolução por id, 3 pedidos reais (um com split Pix + crédito) | **idempotente**, rateio idêntico antes e depois |
| Ciclo completo com divergência fabricada (−R$ 7,77 numa perna Pix de 19/09) | detectou **1 em 751**, corrigiu, restaurou ao centavo, registrou `corrigido`, **zero falso positivo** nos outros 750 |
| Rota completa, chamada real | HTTP 200, 89.853 ms registrados em `job_runs` |

A primeira linha é a mais importante e merece ser lida devagar: em 2.386 pedidos de três dias
inteiros, o ledger concorda com a Shopify **pedido a pedido**. É o terceiro resultado independente
apontando na mesma direção, agora numa amostra duas ordens de magnitude maior que a de 09/09.

### Duas frestas que restam abertas

Nenhuma das duas apareceu nos números de 07/09, mas as duas são reais:

1. **Data da perna é `MAX(processed_at)` do gateway** (`buildGatewayTotals` em
   [shopify-order-transactions.ts](../src/features/integration/shopify-order-transactions.ts)). Um
   gateway com duas transações em dias diferentes tem o valor inteiro datado no dia mais tarde.
2. **Transações `test` não são filtradas** em nenhum ponto do caminho do ledger — só `status` e
   `kind` são.

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
