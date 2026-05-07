# Plano de Implementacao v0.2 - Ajustes Financeiro e Contabil

## Objetivo
Aplicar melhorias operacionais no Dashboard e Fluxo de Caixa apos alinhamento com os times Financeiro e Contabil, com foco em periodo padrao, seletores de periodo, qualidade de dados Shopify (RAW), paginacao de detalhamento e novos cards financeiros.

## Escopo confirmado
- Dashboard e Fluxo de Caixa iniciam por padrao com Ontem (dia fechado).
- Seletores de periodo em Dashboard e Fluxo de Caixa: Ontem, Hoje, 7 dias, 30 dias, 60 dias e 90 dias.
- Captura de dados RAW Shopify para valor total e frete/envio.
- Revisao robusta da forma de pagamento no RAW Shopify para reduzir classificacoes em Outro/Nao informado.
- Paginacao da lista detalhada de pedidos/entradas no Fluxo de Caixa para o periodo apurado.
- Inclusao de cards adicionais: Descontos, Taxas e Entrega, com fallback em zero quando dado nao estiver disponivel.

## Regras e decisoes de negocio
- Ontem significa janela fechada: 00:00:00.000 ate 23:59:59.999.
- Presets de periodo sao obrigatorios nas duas telas principais (Dashboard e Fluxo de Caixa).
- A paginacao solicitada vale para a lista detalhada de entradas/pedidos, nao para a agregacao por origem.
- Cards de Descontos, Taxas e Entrega devem exibir 0 quando o RAW nao trouxer o dado.
- Devem ser preservados envelope de API, ActionResult e seguranca com withApiSecurity.

## Status de execucao (atualizado em 07/05/2026)

### Resumo
- Implementacao tecnica das Fases 1 a 7 concluida.
- Ajustes de layout complementares aplicados apos a execucao principal:
   - Dashboard atualizado para ocupar toda a largura util.
   - Fluxo de Caixa com bloco "Por origem" movido para o final da pagina.
- Validacoes tecnicas obrigatorias executadas com sucesso (lint, typecheck, boundaries, contracts, build).

### Status por fase
- Fase 1 - Concluida
   - Default em Ontem aplicado no Dashboard e no Fluxo de Caixa.
   - Presets Ontem, Hoje, 7, 30, 60 e 90 dias ativos nas duas telas.
- Fase 2 - Concluida
   - Dominio de cash-flow aceita preset e preserva filtro customizado por startDate/endDate.
   - Calculo com dias fechados para Ontem/Hoje centralizado no dominio.
- Fase 3 - Concluida
   - Payload Shopify expandido com campos de shipping, descontos, impostos, transactions e notas.
   - Resolucao de forma de pagamento reforcada com cadeia de prioridade no RAW.
- Fase 4 - Concluida
   - Persistencia de breakdown financeiro por transacao implementada (shippingCents, discountCents, taxCents, feeCents).
   - Migration Prisma criada e aplicada para novos campos.
- Fase 5 - Concluida
   - Cards de Descontos, Taxas e Entrega adicionados no Dashboard e Fluxo de Caixa.
   - Comparativo com periodo anterior mantido e fallback em zero aplicado.
- Fase 6 - Concluida
   - Lista detalhada de entradas no Fluxo de Caixa paginada via querystring.
   - Navegacao de pagina preserva filtros ativos.
- Fase 7 - Concluida
   - Sync Shopify passou a classificar falhas por categoria em failureReasons.
   - Logs de conclusao de sync incluem motivos agregados para diagnostico.

### Pendencias operacionais
- Executar rodada final de testes manuais com dados reais para homologacao funcional:
   - Presets nas duas telas.
   - Paginacao da lista detalhada.
   - Confirmacao de classificacao de formas de pagamento no RAW real.
   - Revisao visual final de Dashboard (largura total) e Fluxo de Caixa (ordem das secoes).

---

## Fase 1 - Periodo padrao e presets de periodo

### Status atual
- Concluida

### Objetivo
Padronizar o comportamento inicial e os atalhos de periodo nas duas telas.

### Entregas
1. Alterar default de abertura para Ontem em:
   - Dashboard
   - Fluxo de Caixa
2. Adicionar presets visiveis e funcionais:
   - Ontem
   - Hoje
   - 7 dias
   - 30 dias
   - 60 dias
   - 90 dias
3. Manter persistencia via querystring para compartilhamento de links.

### Arquivos alvo
- src/app/financeiro/dashboard/page.tsx
- src/app/financeiro/fluxo-de-caixa/page.tsx
- src/lib/date-utils.ts (se necessario para helper de preset)

---

## Fase 2 - Contrato de periodo no dominio

### Status atual
- Concluida

### Objetivo
Evitar logica duplicada de periodo na UI e centralizar no dominio.

### Entregas
1. Introduzir filtro de preset (ex.: yesterday, today, d7, d30, d60, d90) no dominio de cash-flow.
2. Preservar suporte a startDate/endDate para filtro customizado.
3. Garantir consistencia de dias completos para Ontem e Hoje.

### Arquivos alvo
- src/features/cash-flow/types.ts
- src/features/cash-flow/actions.ts
- src/features/cash-flow/service.ts

---

## Fase 3 - Evolucao do RAW Shopify

### Status atual
- Concluida

### Objetivo
Capturar mais informacoes do pedido e melhorar a inferencia da forma de pagamento.

### Entregas
1. Expandir payload tipado para incluir campos relevantes:
   - total_shipping_price
   - total_discounts
   - total_tax
   - transactions
   - note_attributes
   - note
2. Melhorar algoritmo de pagamento com prioridade:
   1) payment_gateway_names
   2) transactions/payment_details
   3) gateway
   4) note_attributes
   5) note
3. Refinar normalizacao para reduzir casos de Other/nao informado.

### Arquivos alvo
- src/features/integration/types.ts
- src/features/integration/payment-method.ts
- src/features/integration/shopify-orders-sync.ts
- src/features/integration/shopify-webhook-handler.ts

---

## Fase 4 - Persistencia de breakdown financeiro por pedido

### Status atual
- Concluida

### Objetivo
Guardar no banco os componentes financeiros necessarios para cards e analise.

### Entregas
1. Adicionar colunas opcionais em FinancialTransaction:
   - shippingCents
   - discountCents
   - taxCents
   - feeCents (quando inferivel)
2. Criar migration Prisma.
3. Mapear sync e webhook para preencher valores e aplicar fallback em 0 quando ausente.

### Arquivos alvo
- prisma/schema.prisma
- prisma/migrations/*
- src/features/transactions/types.ts
- src/features/transactions/repository.ts
- src/features/integration/shopify-orders-sync.ts
- src/features/integration/shopify-webhook-handler.ts

---

## Fase 5 - Novos cards no Dashboard e Fluxo de Caixa

### Status atual
- Concluida

### Objetivo
Exibir indicadores adicionais para tomada de decisao financeira.

### Entregas
1. Adicionar cards:
   - Descontos
   - Taxas
   - Entrega
2. Incluir comparativo com periodo anterior quando houver base.
3. Aplicar fallback em zero quando o dado nao existir no RAW/persistencia.

### Arquivos alvo
- src/app/financeiro/dashboard/page.tsx
- src/app/financeiro/fluxo-de-caixa/page.tsx
- src/features/cash-flow/types.ts
- src/features/cash-flow/service.ts

---

## Fase 6 - Paginacao da lista detalhada no Fluxo de Caixa

### Status atual
- Concluida

### Objetivo
Permitir navegacao completa pelos pedidos/entradas do periodo apurado.

### Entregas
1. Paginar lista detalhada por querystring (page, limit).
2. Preservar filtros ativos (periodo, forma de pagamento, origem) ao trocar pagina.
3. Mostrar metadados de pagina (total, pagina atual, proxima/anterior).

### Arquivos alvo
- src/app/financeiro/fluxo-de-caixa/page.tsx
- src/features/transactions/validations.ts
- src/features/transactions/repository.ts
- src/app/api/financial/transactions/route.ts (se ajuste de passagem for necessario)

---

## Fase 7 - Observabilidade e qualidade de ingestao

### Status atual
- Concluida

### Objetivo
Reduzir falhas no sync e tornar diagnostico acionavel.

### Entregas
1. Classificar falhas por motivo no sync Shopify (parse, validacao, upsert, payload incompleto etc.).
2. Melhorar logs estruturados para identificar causas dominantes de falha.
3. Acompanhar taxa de mapeamento de payment method por tipo normalizado.

### Arquivos alvo
- src/features/integration/shopify-orders-sync.ts
- src/core/observability/logger.ts (somente se precisar ampliar campos)

---

## Verificacao tecnica obrigatoria
### Status atual
- Automacoes concluidas
- Homologacao manual pendente

1. Rodar migration Prisma e regenerate client.
2. Executar npm run lint.
3. Executar npm run typecheck.
4. Executar npm run check:boundaries.
5. Executar npm run check:contracts.
6. Executar npm run build.
7. Executar testes manuais:
   - Abertura default em Ontem nas duas telas
   - Presets Ontem/Hoje/7/30/60/90
   - Paginacao da lista detalhada
   - Cards Descontos/Taxas/Entrega com fallback 0
   - Validacao de pagamentos Shopify (Pix, cartao, boleto, wallet)

## Riscos e mitigacoes
- Risco: dados RAW incompletos para certos gateways.
  - Mitigacao: fallback para zero nos cards e cadeia de prioridade para payment method.
- Risco: regressao de UX por mudanca de default para Ontem.
  - Mitigacao: presets visiveis e claros, com opcao Hoje em 1 clique.
- Risco: volume alto de falhas no sync mascarar ganhos.
  - Mitigacao: telemetria por motivo de falha e plano de correcao iterativo.

## Ordem recomendada de execucao
1. Fase 1
2. Fase 2
3. Fase 3
4. Fase 4
5. Fase 5
6. Fase 6
7. Fase 7
