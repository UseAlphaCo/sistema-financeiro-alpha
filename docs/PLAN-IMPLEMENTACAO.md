# Plano de Implementacao - Sistema Financeiro

## Objetivo
Construir um app financeiro separado para fluxo de caixa, dashboard consolidado, importacao de planilhas e previsao de entrada liquida por marketplace.

## Escopo confirmado
- Integracao com endpoints financeiros do sistema atual
- Ingestao por webhooks equivalentes da Shopify com HMAC e idempotencia
- Lancamentos manuais e importacao de Excel/CSV
- Cadastro/importacao de taxas por marketplace (Shopify, Mercado Livre, Shopee e Amazon)
- Projecao de caixa com base em bruto, taxas e liquido
- Reconcilacao de dados e observabilidade

## Sprint 1 (em andamento)
- Story 1.1 Bootstrap do projeto
- Story 1.2 Guardrails arquiteturais
- Story 1.3 Padrao operacional CLAUDE/agents
- Story 2.1 Autenticacao e autorizacao por role
- Story 2.2 Seguranca de API e observabilidade minima
- Story 4.1 Modelo base de transacoes (scaffold inicial)

## Ordem de execucao recomendada
1. Sprint 1: fundacao, seguranca, guardrails e base de dados
2. Sprint 2: integracoes externas e importacoes
3. Sprint 3: fluxo de caixa e taxas de marketplace
4. Sprint 4: previsao, dashboard consolidado e reconciliacao

## Definicoes tecnicas obrigatorias
- Envelope de API padrao: success, data, error, requestId, meta
- ActionResult para actions server-side
- Controle de acesso por role admin/financeiro
- Rate limit por endpoint sensivel
- RequestId obrigatorio em respostas e logs
- Janela temporal com dias completos (00:00:00.000 -> 23:59:59.999)
