# Plano de Reconciliação Shopify (Sprint Curto)

Data de início: 2026-06-30
Escopo: ajustar reconciliação para visão transacional por gateway com metadados de janela e testes mínimos.

## Objetivo

Aproximar a saída de reconciliação da semântica do relatório Shopify de pagamentos, com foco em:
- visão por gateway
- distinção entre bruto, reembolso e líquido
- janela temporal explícita para auditoria

## Status do Sprint

> Nota (2026-07-21): os itens abaixo foram marcados como concluídos neste
> documento, mas o código correspondente nunca foi mesclado ao `main` —
> confirmado via `git log -- src/features/reconciliation/` (só existe o
> commit inicial `b32d4a9`) e ausência de `gatewaySummary`/`window` em
> `src/features/reconciliation/service.ts`, além de `service.test.ts` não
> existir no disco. Este trabalho está fora de escopo da sprint atual por
> decisão do time.

- [ ] Expandir contrato de resultado com resumo por gateway
- [ ] Incluir metadados de janela na saída (timezone, fonte, start/end UTC)
- [ ] Implementar agregação por gateway no serviço de reconciliação
- [ ] Adicionar testes unitários para cálculo de gross/refund/net por gateway
- [ ] Adicionar teste unitário para retorno de janela e resumo no runReconciliation
- [ ] Validar comparativo com baseline operacional do script Shopify em data real
- [ ] Decidir evolução para fonte transacional dedicada (persistência de transações Shopify)

## Implementação aplicada

**Não aplicada.** A seção abaixo descreve o trabalho planejado para esta etapa,
mas não existe no `main` (ver nota em "Status do Sprint").

Arquivos que seriam alterados:
- src/features/reconciliation/types.ts
- src/features/reconciliation/service.ts
- src/features/reconciliation/service.test.ts

Resultado técnico pretendido (não implementado):
- ReconciliationResult exporia gatewaySummary com valores em centavos por gateway.
- ReconciliationResult exporia window com timezone, source, startUtc e endUtcExclusive.
- Serviço usaria agregação por método de pagamento para transações Shopify (marketplace/source) na janela informada.

## Critérios de validação desta etapa

- Testes de reconciliação verdes
- Typecheck sem erros

## Observações

- Nesta etapa não houve migração de schema para metadata adicional em ReconciliationSnapshot.
- Persistência detalhada de metadados de reconciliação permanece como próximo incremento.

## Relação com o job de resolução de gateway titular (2026-07-26)

O problema central desta sprint — decidir o gateway "certo" de um pedido
Shopify com pagamento dividido — acabou resolvido por um caminho diferente
do planejado aqui: em vez de expandir `reconciliation/service.ts`, foi criada
uma tabela dedicada (`integration.shopify_order_payment_resolution`) e um job
próprio (`src/features/integration/shopify-payment-resolution-job.ts`) que
calcula o gateway titular por maior valor pago (ver
[docs/shopify/shopify-payments-by-gateway.md](./shopify/shopify-payments-by-gateway.md)
para a regra de negócio) e alimenta `read-model.ts` via LEFT JOIN. Resolve o
caso de uso original desta sprint (gateway correto por pedido no Fluxo de
Caixa), mas não implementa `gatewaySummary`/`window` em
`ReconciliationResult` — a tela de Reconciliação em si segue sem ler dados do
mirror (ver Fase 4 do plano de auditoria do projeto).
