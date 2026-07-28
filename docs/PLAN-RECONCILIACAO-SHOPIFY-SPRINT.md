# Plano de Reconciliação Shopify (Sprint Curto)

> **STATUS (2026-07-27): SUPERADO/FECHADO.** O objetivo de negócio desta
> sprint (gateway titular correto por pedido Shopify com pagamento dividido)
> foi resolvido por outro caminho — ver "Relação com o job de resolução de
> gateway titular" no final deste documento. Os itens do checklist abaixo
> nunca foram implementados e não serão: a própria feature de Reconciliação
> (`src/features/reconciliation/*`, `/financeiro/reconciliacao`) foi
> **removida do código no commit `8195b57`** (decisão do time — não usada,
> nunca lia o mirror). A validação de valores/transações Sistema x Shopify
> segue hoje por `npm run verify:shopify` e pela rota automatizada
> `/api/internal/cron/shopify-verify`, não pela tela de Reconciliação.

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

- [x] ~~Expandir contrato de resultado com resumo por gateway~~ — superado (feature de Reconciliação removida em `8195b57`)
- [x] ~~Incluir metadados de janela na saída (timezone, fonte, start/end UTC)~~ — superado (janela/timezone hoje vivem em `shopify-value-verification.ts`)
- [x] ~~Implementar agregação por gateway no serviço de reconciliação~~ — superado (resolvido via `shopify-payment-resolution-job.ts` + tabela dedicada)
- [x] ~~Adicionar testes unitários para cálculo de gross/refund/net por gateway~~ — superado, sem código correspondente para testar
- [x] ~~Adicionar teste unitário para retorno de janela e resumo no runReconciliation~~ — superado, `runReconciliationAction` não existe mais
- [x] Validar comparativo com baseline operacional do script Shopify em data real — feito via `npm run verify:shopify` (ver seção final)
- [x] Decidir evolução para fonte transacional dedicada (persistência de transações Shopify) — decidido: tabela `integration.shopify_order_payment_resolution`

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
Caixa).

**Atualização (2026-07-27):** a tela de Reconciliação foi removida do código
(commit `8195b57`), então o ponto acima sobre `gatewaySummary`/`window` em
`ReconciliationResult` deixou de ser relevante — não há mais tela de
Reconciliação para expandir. A referência original a "Fase 4 do plano de
auditoria do projeto" corresponde à seção "Governança (Fase 4/6/7)" de
[docs/PLAN-OMS-READONLY-CORE-CONTROLE.md](./PLAN-OMS-READONLY-CORE-CONTROLE.md)
(migração de histórico legado para auditoria, permissão SELECT-only no OMS,
limpeza de tabelas legadas) — pendências de governança de dados, não de
reconciliação em si.

A validação de valores/número de transações Sistema x Shopify segue hoje por
`npm run verify:shopify` (script CLI) e pela rota automatizada
`/api/internal/cron/shopify-verify` (checagem horária, sempre D-1, com
auto-alinhamento via `runShopifyPaymentResolutionJob` quando a divergência é
considerada um alerta real — ver
[src/features/integration/shopify-value-verification.ts](../src/features/integration/shopify-value-verification.ts)).
