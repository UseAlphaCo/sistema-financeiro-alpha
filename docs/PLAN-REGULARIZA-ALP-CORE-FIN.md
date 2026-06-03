# Plano de Regularizacao do ALP-CORE-FIN

> Status deste documento neste ciclo: referencia de apoio para regularizacao.
>
> Fonte unica de execucao da rodada atual: `docs/PLAN-EXECUCAO-UNIFICADO-ALP-CORE-FIN.md`.
>
> Em caso de conflito entre planos, prevalece o plano unificado.

Data: 2026-06-02
Status: Planejado

## Objetivo
Regularizar o ambiente ALP-CORE-FIN para suportar o sistema financeiro completo, garantindo bootstrap do schema public, dados minimos de operacao e evidencias formais para avancar os gates de cutover sem regressao estrutural.

## Contexto
- O schema mirror esta ativo e sendo usado no read model.
- O schema public do ALP-CORE-FIN nao esta completo no ambiente atual.
- A aplicacao depende de tabelas no public para autenticacao, categorias, transacoes manuais/importadas e suporte operacional.
- Sem regularizacao do public, o Gate B (paridade funcional) fica parcial e o Gate C (cutover seguro) nao pode ser fechado.

## Escopo incluido
- Diagnostico tecnico do estado atual do banco alvo.
- Aplicacao de migracoes Prisma para bootstrap completo do schema public.
- Validacao de enums, tabelas, constraints e indices criticos.
- Execucao de seed minimo para admins e categorias iniciais.
- Validacao funcional minima em login, dashboard, fluxo, reconciliacao, importacoes e lancamentos.
- Consolidacao de evidencias para atualizacao de status dos gates.

## Fora de escopo
- Refatoracao ampla de regras de negocio nao relacionadas a regularizacao estrutural.
- Mudancas de UX sem relacao com falhas de schema.
- Ajustes de performance fora de incidentes diretamente causados por bootstrap ausente.

## Regras e decisoes
- Banco alvo unico para esta etapa: ALP-CORE-FIN.
- Nao executar mudancas estruturais concorrentes durante a janela de regularizacao.
- Aplicar migracoes somente na ordem versionada de prisma/migrations.
- Tratar divergencias em 3 classes: schema, regra de negocio, dados de origem.
- Registrar evidencia objetiva por fase: comando, resultado, data/hora e decisao.

---

## Fase 0 - Preparacao operacional
### Objetivo
Garantir janela controlada para evitar drift entre diagnostico e execucao.

### Entregas
1. Definir responsavel unico de execucao e aprovacao.
2. Confirmar janela de manutencao e criterio de rollback.
3. Congelar alteracoes estruturais paralelas no banco alvo.

### Criterio de saida
- Janela aprovada, responsavel nomeado e plano de rollback acordado.

---

## Fase 1 - Diagnostico de lacunas do ambiente
### Objetivo
Levantar o delta entre estado real do ALP-CORE-FIN e contrato esperado da aplicacao.

### Entregas
1. Inventariar schemas, tabelas, enums, indices e privilegios atuais.
2. Confrontar inventario real com schema Prisma e migracoes versionadas.
3. Classificar lacunas por criticidade:
   - Bloqueante de autenticacao
   - Bloqueante de fluxo financeiro
   - Bloqueante de suporte operacional
4. Publicar relatorio inicial de lacunas com evidencias.

### Criterio de saida
- Lista de lacunas fechada e priorizada por impacto funcional.

---

## Fase 2 - Pre-check de seguranca e execucao
### Objetivo
Evitar falha de execucao por permissao, search_path incorreto ou variavel de ambiente errada.

### Entregas
1. Validar privilegios de CREATE/ALTER no schema public para o usuario de migracao.
2. Validar privilegios de leitura/escrita no mirror conforme escopo operacional.
3. Confirmar search_path efetivo.
4. Confirmar variaveis de ambiente de migracao e seed no alvo correto.
5. Gerar backup logico ou snapshot pre-regularizacao.

### Criterio de saida
- Ambiente apto para aplicar migracoes com seguranca e recuperacao prevista.

---

## Fase 3 - Bootstrap do schema public
### Objetivo
Criar toda estrutura obrigatoria do public para suportar o sistema atual.

### Entregas
1. Aplicar todas as migracoes pendentes de prisma/migrations.
2. Confirmar criacao dos enums:
   - UserAccountRole
   - UserAccountStatus
3. Confirmar criacao das tabelas criticas:
   - User
   - FinancialTransaction
   - TransactionCategory
   - DailySnapshot
   - ImportBatch
   - ImportBatchRow
   - ReconciliationSnapshot
   - WebhookEvent
   - MarketplaceFee
4. Confirmar constraints e indices criticos:
   - User_email_key
   - TransactionCategory_name_key
   - FinancialTransaction_externalSource_externalId_key
   - Indices de occurredAt, source, type, status, deletedAt

### Criterio de saida
- Estrutura do public aderente ao contrato Prisma e sem objetos criticos faltando.

---

## Fase 4 - Seed minimo e integridade funcional
### Objetivo
Garantir dados base de autenticacao e operacao financeira.

### Entregas
1. Executar seed para admins iniciais.
2. Executar seed para categorias iniciais.
3. Validar ausencia de duplicidade invalida apos seed.
4. Validar login de admin e autorizacao por role.

### Criterio de saida
- Base minima operacional disponivel para uso das funcionalidades financeiras.

---

## Fase 5 - Validacao funcional e paridade minima
### Objetivo
Comprovar que a aplicacao deixa de falhar por lacuna estrutural e avanca no Gate B.

### Entregas
1. Rodar smoke funcional em:
   - Dashboard
   - Fluxo de caixa
   - Reconciliacao
   - Importacoes
   - Lancamentos
   - Usuarios
2. Validar coexistencia entre leitura via mirror e dados manuais/importados.
3. Rodar baseline comparativo minimo e registrar divergencias.
4. Classificar divergencias em schema, regra de negocio ou dado de origem.

### Criterio de saida
- Sem falha estrutural por ausencia de tabela e com divergencias remanescentes classificadas.

---

## Fase 6 - Governanca de evidencia e atualizacao de gates
### Objetivo
Transformar execucao tecnica em decisao operacional auditavel.

### Entregas
1. Consolidar checklist final com status item a item.
2. Atualizar status da Fase 4.2 e Gate B no plano de cutover.
3. Formalizar decisao:
   - Bootstrap concluido
   - Bootstrap parcial com pendencias
4. Publicar plano corretivo para pendencias nao bloqueantes.

### Criterio de saida
- Status de gate atualizado com base em evidencias verificaveis.

---

## Fase 7 - Encerramento seguro e rollback
### Objetivo
Garantir recuperacao rapida em caso de regressao critica pos-regularizacao.

### Entregas
1. Validar procedimento de rollback e tempo alvo.
2. Definir gatilhos objetivos de rollback.
3. Registrar termo de encerramento da janela.

### Criterio de saida
- Encerramento formal da rodada com risco residual conhecido.

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

## Paralelizacao permitida
- Fase 1 (inventario) e consolidacao documental podem ocorrer em paralelo apos Fase 0.
- Smokes de API e UI podem ocorrer em paralelo na Fase 5.
- Nao paralelizar aplicacao de migracoes com qualquer outra alteracao estrutural.

## Checklist operacional
- [ ] Janela aprovada e responsavel nomeado.
- [ ] Backup/snapshot pre-execucao criado.
- [ ] Privilegios e search_path validados.
- [ ] Migracoes aplicadas sem erro.
- [ ] Enums e tabelas criticas confirmadas.
- [ ] Indices e constraints criticos confirmados.
- [ ] Seed de admins e categorias aplicado.
- [ ] Login admin validado.
- [ ] Smoke funcional das telas e endpoints executado.
- [ ] Baseline comparativo minimo registrado.
- [ ] Gate B/Fase 4.2 atualizados com evidencia.
- [ ] Plano de rollback validado.

## Verificacao tecnica obrigatoria
1. Rodar typecheck.
2. Rodar check:boundaries.
3. Rodar check:contracts.
4. Rodar test.
5. Rodar build.

## Evidencias esperadas
- Inventario do estado inicial do banco.
- Resultado da aplicacao de migracoes.
- Comprovante de objetos criados no public.
- Comprovante de seed aplicado.
- Evidencia de login e acesso por role.
- Evidencia dos smokes de dashboard/fluxo/reconciliacao/importacoes/lancamentos/usuarios.
- Registro de divergencias classificadas.
- Atualizacao formal de status de gate e fase.

## Riscos e mitigacoes
- Risco: migracao aplicada em banco incorreto.
  - Mitigacao: validacao de variaveis e confirmacao explicita do alvo antes da execucao.
- Risco: permissao insuficiente para criar objetos no public.
  - Mitigacao: pre-check de grants antes de iniciar migracoes.
- Risco: seed aplicado em ambiente indevido.
  - Mitigacao: executar seed somente na janela aprovada e com conferencias pos-seed.
- Risco: regressao funcional apos bootstrap.
  - Mitigacao: smoke funcional e baseline comparativo na mesma janela.

## Arquivos relevantes
- prisma/schema.prisma
- prisma/migrations/20260505182444_init/migration.sql
- prisma/migrations/20260505192735_add_import_batch_row/migration.sql
- prisma/migrations/20260506190356_add_marketplace_transaction_metadata/migration.sql
- prisma/migrations/20260507133756_add_transaction_breakdown_fields/migration.sql
- prisma/migrations/20260507161954_unique_transaction_category_name/migration.sql
- prisma/migrations/20260507202533_add_daily_snapshot/migration.sql
- prisma/migrations/20260520180950_add_user_management/migration.sql
- prisma/seed.ts
- src/core/auth/auth.config.ts
- src/features/transactions/repository.ts
- src/features/transactions/read-model.ts
- src/features/cash-flow/service.ts
- docs/PLAN-WORKER-SYNC.md

## Registro de andamento
- 2026-06-02 - Plano criado para regularizacao estrutural do ALP-CORE-FIN com foco em bootstrap do public e evidencias de gate.

## Ritmo de atualizacao
- Atualizar status da fase ao finalizar cada bloco.
- Registrar evidencias objetivas na mesma data da execucao.
- Em mudanca de escopo, adicionar decisao com motivo e impacto antes de seguir.
