# Plano Unificado de Execucao - ALP-CORE-FIN Mirror First

Data: 2026-06-02
Status: Planejado

> **Nota de precedencia (2026-07-26):** este documento se autodeclara "fonte
> unica" do ciclo, mas foi sucedido por
> [PLAN-OMS-READONLY-CORE-CONTROLE.md](./PLAN-OMS-READONLY-CORE-CONTROLE.md)
> (2026-07-01, atualizado 2026-07-13), que reflete a arquitetura de sync
> realmente em producao (OMS read-only, controle de fila/lock/DLQ no CORE via
> `integration.sync_queue`). Em caso de conflito entre os dois, o plano
> OMS-READONLY-CORE-CONTROLE prevalece. Este documento fica mantido como
> registro historico da decisao mirror-first original.

## Objetivo
Executar o cutover operacional do Sistema Financeiro para ALP-CORE-FIN com estrategia mirror-first, garantindo que exibicao e consolidacao financeira usem exclusivamente mirror.raw_payloads, sem conexao direta com Shopify no app.

## Fonte unica deste ciclo
Este documento consolida e substitui, para fins de execucao desta rodada:
- docs/PLAN-WORKER-SYNC.md
- docs/PLAN-REGULARIZA-ALP-CORE-FIN.md

## Anexos operacionais desta rodada
- docs/PLAN-INTEGRACOES-GATILHO-WORKER-RETROATIVO.md (plano detalhado da Fase 4 para gatilho assincrono do Worker com retroativo de 90 dias)
- docs/PLAN-FINALIZACAO-WORKER-MINIMO-ONLINE.md (plano de execucao para concluir o Worker no nivel minimo de publicacao online)

## Controle de versao do plano
- 2026-06-02 (v1.0): plano unificado criado como fonte unica de execucao do ciclo ALP-CORE-FIN mirror-first.
- 2026-06-02 (v1.1): consolidacao das decisoes mandatórias da rodada (sem reconciliacao, mirror via Worker, origem por marketplace, somente pagos, consolidado diario no mirror).
- 2026-06-02 (v1.2): formalizacao de substituicao operacional dos planos legados com regra de prevalencia do plano unificado em caso de conflito.
- 2026-06-02 (v1.3): vinculacao do plano operacional de Integracoes para gatilho assincrono do Worker com retroativo de 90 dias.
- 2026-06-03 (v1.4): vinculacao do plano de finalizacao do Worker com criterio minimo para publicacao online.

## Decisoes mandatórias da rodada
1. Nao mexer em reconciliacao nesta rodada.
2. Integracoes devem operar via Worker para manter mirror alinhado com ALP-OMS.raw_payloads.
3. No sistema, Origem exibida deve representar o marketplace de negocio do registro.
4. Apenas pedidos pagos devem ser exibidos no Sistema Financeiro.
5. Consolidado diario deve ser criado a partir de mirror.raw_payloads, sem conexao direta com Shopify.

## Escopo incluido
- Bootstrap do schema public do ALP-CORE-FIN para suportar auth, usuarios e dominio financeiro atual.
- Operacao mirror-first para leitura financeira (listagem, cards, somatorios, faturamento).
- Desativacao de ingestao Shopify direta no app (webhook e sync manual).
- Validacao funcional de dashboard, fluxo de caixa, transacoes, importacoes, lancamentos e usuarios.
- Consolidacao de evidencias para Gate B e Gate C.

## Fora de escopo
- Alteracoes na feature de reconciliacao.
- Refatoracoes amplas de UX sem relacao com regras de fonte de dados.
- Novas regras de negocio nao relacionadas ao cutover mirror-first.

## Regras de dados e exibicao
- Fonte oficial de pedidos/transacoes financeiras: ALP-CORE-FIN.mirror.raw_payloads.
- Origem exibida em UI/API: marketplace de negocio (Shopify, Mercado Livre, Amazon etc.), nao source tecnico.
- source tecnico permanece interno para controle de adaptador/pipeline.
- Inclusao em telas e agregados: somente pedidos pagos.
- Registros tecnicos de teste devem ser excluidos da exibicao e metricas operacionais.

---

## Fase 0 - Preparacao operacional
### Objetivo
Garantir janela controlada e governanca da execucao.

### Entregas
1. Definir responsavel unico de execucao e aprovacao.
2. Confirmar janela de manutencao e plano de rollback.
3. Congelar alteracoes estruturais concorrentes no banco alvo.

### Criterio de saida
- Janela aprovada, responsavel definido e rollback acordado.

---

## Fase 1 - Diagnostico e pre-check do ambiente
### Objetivo
Confirmar prontidao tecnica para aplicar bootstrap e cutover mirror-first.

### Entregas
1. Inventariar estado atual do ALP-CORE-FIN (schemas, tabelas, enums, indices, grants).
2. Confirmar search_path e variaveis de ambiente da execucao.
3. Validar privilegios de migracao e operacao no mirror.
4. Gerar backup logico/snapshot pre-execucao.

### Criterio de saida
- Ambiente apto para migracoes e operacao segura.

---

## Fase 2 - Bootstrap completo do schema public
### Objetivo
Criar toda estrutura obrigatoria do app no ALP-CORE-FIN public.

### Entregas
1. Aplicar migracoes Prisma pendentes na ordem versionada.
2. Confirmar enums: UserAccountRole e UserAccountStatus.
3. Confirmar tabelas criticas:
   - User
   - FinancialTransaction
   - TransactionCategory
   - DailySnapshot
   - ImportBatch
   - ImportBatchRow
   - ReconciliationSnapshot
   - WebhookEvent
   - MarketplaceFee
4. Confirmar constraints e indices criticos de auth e transacoes.

### Criterio de saida
- Public aderente ao contrato Prisma e sem objeto critico faltante.

---

## Fase 3 - Seed minimo e autenticação
### Objetivo
Habilitar operacao base de usuarios e categorias.

### Entregas
1. Executar seed de admins iniciais e categorias.
2. Validar unicidade e consistencia dos dados seedados.
3. Validar login admin e autorizacao por role.

### Criterio de saida
- Base minima operacional pronta para uso das telas financeiras.

---

## Fase 4 - Integracoes mirror-first (sem Shopify direto)
### Objetivo
Remover dependencias diretas de Shopify e consolidar fluxo oficial via Worker.

### Entregas
1. Desativar endpoint de webhook Shopify do app com retorno controlado e log.
2. Desativar endpoint de sync manual Shopify do app com retorno controlado e log.
3. Garantir fluxo oficial:
   - ALP-OMS.raw_payloads
   - integration.sync_events
   - Worker
   - ALP-CORE-FIN.mirror.raw_payloads
4. Validar que nao existe gravacao direta de pedidos Shopify em FinancialTransaction no app.

### Criterio de saida
- Shopify direto desativado e pipeline do Worker como unico caminho de ingestao.

---

## Fase 5 - Read model e regra de pagos
### Objetivo
Assegurar exibicao correta por marketplace e filtro de pedidos pagos.

### Entregas
1. Ajustar read model para expor Origem como marketplace de negocio.
2. Aplicar filtro obrigatorio de pedidos pagos no read model.
3. Definir fallback seguro para status de pagamento ausente/invalido.
4. Excluir registros tecnicos de teste da exibicao e agregados.

### Criterio de saida
- Listagens e agregados exibem apenas pedidos pagos com Origem por marketplace.

---

## Fase 6 - Consolidado diario no mirror
### Objetivo
Garantir consolidacao financeira diaria sem dependencia Shopify direta.

### Entregas
1. Implementar consolidado diario exclusivamente sobre mirror.raw_payloads.
2. Garantir regra de pedidos pagos no consolidado.
3. Garantir classificacao por marketplace no consolidado.
4. Integrar consolidado diario ao dashboard e fluxo de caixa.

### Criterio de saida
- Consolidado diario consistente com detalhamento e sem fonte direta Shopify.

---

## Fase 7 - Validacao funcional (sem reconciliacao)
### Objetivo
Confirmar operacao ponta a ponta para Gate B sem alterar reconciliacao.

### Entregas
1. Rodar smoke em:
   - Dashboard
   - Fluxo de caixa
   - Transacoes
   - Importacoes
   - Lancamentos
   - Usuarios
2. Validar filtros por periodo, pagamento e marketplace.
3. Rodar baseline comparativo antes/depois para totais e distribuicao por marketplace.
4. Classificar divergencias em:
   - schema
   - mapeamento de payload
   - regra de pago
   - agregacao diaria
   - dado de origem

### Criterio de saida
- Sem falha estrutural e com divergencias tratadas/classificadas para fechamento de Gate B.

---

## Fase 8 - Governanca de evidencias e fechamento de gates
### Objetivo
Concluir rodada com decisao operacional auditavel.

### Entregas
1. Consolidar checklist final com status item a item.
2. Atualizar status de Gate B e Gate C com evidencias.
3. Validar plano de rollback em teste controlado.
4. Publicar termo de conclusao da rodada e proximos checkpoints.

### Criterio de saida
- Rodada encerrada com evidencias completas e decisao formal de prontidao.

---

## Ordem recomendada de execucao
1. Fase 0
2. Fase 1
3. Fase 2
4. Fase 3
5. Fase 4
6. Fase 5
7. Fase 6
8. Fase 7
9. Fase 8

## Paralelizacao permitida
- Fase 1 pode executar em paralelo com consolidacao documental.
- Fase 7 pode dividir smoke API e smoke UI em paralelo.
- Nao paralelizar migracoes estruturais com outras alteracoes de schema.

## Checklist operacional unificado
- [ ] Janela aprovada e responsavel nomeado.
- [ ] Backup/snapshot pre-execucao criado.
- [ ] Privilegios, search_path e variaveis de ambiente validados.
- [ ] Migracoes Prisma aplicadas sem erro no ALP-CORE-FIN.
- [ ] Enums e tabelas criticas confirmadas no public.
- [ ] Seed de admins e categorias aplicado e validado.
- [ ] Endpoints Shopify diretos desativados com resposta/log controlados.
- [ ] Ingestao oficial via Worker validada.
- [ ] Read model exibindo Origem por marketplace.
- [ ] Filtro de pedidos pagos validado em listagem e cards.
- [ ] Consolidado diario baseado apenas em mirror.raw_payloads.
- [ ] Smoke funcional (sem reconciliacao) executado.
- [ ] Baseline comparativo antes/depois registrado.
- [ ] Typecheck, boundaries, contracts, test e build executados.
- [ ] Gate B e Gate C atualizados com evidencias.
- [ ] Plano de rollback validado.

## Verificacao tecnica obrigatoria
1. npm run typecheck
2. npm run check:boundaries
3. npm run check:contracts
4. npm run test
5. npm run build

## Evidencias esperadas
- Inventario inicial do banco e estado pos-bootstrap.
- Resultado da aplicacao de migracoes e seed.
- Evidencia de desativacao dos endpoints Shopify diretos.
- Evidencia da execucao do Worker e atualizacao do mirror.
- Evidencia de listagem e agregados com Origem por marketplace e apenas pedidos pagos.
- Evidencia de consolidado diario a partir do mirror.
- Relatorio de smoke funcional e baseline comparativo.
- Atualizacao formal de status dos gates.

## Riscos e mitigacoes
- Risco: migracao no banco errado.
  - Mitigacao: confirmar alvo explicitamente antes de executar.
- Risco: payload sem status de pagamento consistente.
  - Mitigacao: fallback seguro para nao incluir como pago sem evidencia.
- Risco: legado chamando endpoint Shopify desativado.
  - Mitigacao: resposta controlada + log estruturado para rastrear origem.
- Risco: divergencia entre consolidado diario e detalhamento.
  - Mitigacao: validacao cruzada por periodo e marketplace antes de fechar Gate B.

## Arquivos alvo de implementacao
- docs/PLAN-WORKER-SYNC.md
- docs/PLAN-REGULARIZA-ALP-CORE-FIN.md
- src/app/api/webhooks/shopify/route.ts
- src/app/api/financial/integrations/shopify/sync/route.ts
- src/features/integration/shopify-webhook-handler.ts
- src/features/integration/shopify-orders-sync.ts
- src/features/transactions/read-model.ts
- src/features/cash-flow/service.ts
- src/app/financeiro/dashboard/page.tsx
- src/app/financeiro/fluxo-de-caixa/page.tsx
- src/app/api/financial/transactions/route.ts
- src/app/api/financial/cash-flow/route.ts

## Registro de andamento
- 2026-06-02 - Plano unificado criado consolidando regularizacao ALP-CORE-FIN e cutover mirror-first.

## Ritmo de atualizacao
- Atualizar status da fase ao concluir cada bloco.
- Registrar evidencias objetivas no mesmo dia da execucao.
- Em mudanca de escopo, registrar decisao com motivo e impacto antes de prosseguir.

## Convencao de versionamento continuo
- Padrao de versao: MAJOR.MINOR.
- Incrementar MAJOR quando houver mudanca de escopo, objetivo central, fonte oficial de dados ou criterio de aceite principal.
- Incrementar MINOR quando houver ajuste incremental de fase, checklist, evidencia, ordem de execucao, risco ou detalhe operacional sem alterar o escopo central.
- Sempre registrar nova versao na secao "Controle de versao do plano" com data, motivo e impacto.
- Em mudanca com impacto de execucao imediata, atualizar no mesmo commit as secoes: Decisoes mandatórias da rodada, Checklist operacional unificado e Registro de andamento.
