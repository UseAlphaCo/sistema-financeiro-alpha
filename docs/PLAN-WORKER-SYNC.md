# PLAN-WORKER-SYNC.md

> Status deste documento neste ciclo: referencia historica e tecnica.
>
> Fonte unica de execucao da rodada atual: `docs/PLAN-EXECUCAO-UNIFICADO-ALP-CORE-FIN.md`.
>
> Em caso de conflito entre planos, prevalece o plano unificado.

# ETAPA 3 — Worker de Sincronização ALP-OMS → ALP-CORE-FIN

## Objetivo

Construir um Worker responsável por sincronizar de forma segura, resiliente e auditável os eventos capturados no `ALP-OMS.integration.sync_events` para o schema `mirror` do projeto `ALP-CORE-FIN`.

---

# Status Atual

Data de referência: 2026-06-02

| Etapa | Status | Observação |
| --- | --- | --- |
| 3.1 MVP | em validacao | Execucao real concluida (100/100 processados), pendente validacoes de robustez |
| 3.2 Robustez | concluido | Backoff, DLQ, lock e testes funcionais INSERT/UPDATE/DELETE validados |
| 3.3 Produção | não iniciado | Depende de robustez e operação |
| 4.1 Paridade Funcional | em andamento | Baseline inicial coletado via script operacional |

Prontidao para consumo total da ALP-CORE-FIN: NAO PRONTO

---

# Sinal Verde de Go-Live (ALP-CORE-FIN)

Esta secao define quando o time pode considerar o sistema pronto para consumir a ALP-CORE-FIN sem perda de funcionalidade.

## Gate A - Sincronizacao e Confiabilidade

* [x] Worker MVP executando com sucesso em ambiente real
* [x] Retry com backoff validado
* [x] DLQ (`integration.failed_jobs`) validada em falha real
* [x] Protecao contra execucao concorrente validada

## Gate B - Paridade Funcional

* [ ] Fluxo de caixa sem regressao funcional
* [ ] Dashboard sem regressao funcional
* [ ] Reconciliacao sem regressao funcional
* [ ] Importacao e lancamentos manuais sem regressao funcional

## Gate C - Cutover Seguro

* [ ] Fonte principal de ingestao apontada para pipeline ALP-OMS -> ALP-CORE-FIN
* [ ] Janela de comparacao paralela (pipeline antigo vs novo) aprovada
* [ ] Plano de rollback testado
* [ ] Variaveis duplicadas de base removidas do `.env` de producao

## Regra de Sinalizacao

Sinalizar "PRONTO PARA ALP-CORE-FIN" somente quando todos os gates A, B e C estiverem 100% concluidos.

---

# Decisões Tomadas

1. Escopo inicial da ETAPA 3: sincronizar somente `mirror.raw_payloads`.
2. Local do Worker: mesmo repositório atual (não será repo separado).
3. Modelo de execução do MVP: agendado por cron (modo one-shot por execução).
4. Regra para evento `DELETE`: remover registro correspondente em `mirror.raw_payloads`.
5. Permissão de escrita no ALP-OMS: somente `integration.sync_events` para controle técnico (`processed`, `processed_at`, `retries`, `error_message`).
6. O ALP-OMS permanece sem alterações de domínio pela ETAPA 3.
7. Implementação inicial do Worker em `src/workers/sync` com execução one-shot via script `npm run worker:sync:once`.
8. A leitura de transações para o front deve sair de `ALP-CORE-FIN.mirror.raw_payloads.payload_json` com projeção orientada por `source` e `marketplace`, não por um parser único.
9. `source` identifica o adaptador/origem de ingestão; `marketplace` é um atributo de negócio exibido no financeiro.
10. Para `source = shopify`, o marketplace exibido deve ser fixo como `Shopify`.
11. Para `source = anymarket`, o marketplace exibido deve ser derivado de `payload_json.marketPlace` (ex.: Mercado Livre, Amazon e outros).
12. Registros técnicos de teste, como `source = gatea-test-updated`, não entram no read model do financeiro.
13. O plano de cutover passa a considerar migração total para ALP-CORE-FIN, incluindo bootstrap de schema completo, desativação da ingestão Shopify no app atual e read model financeiro a partir do mirror.

---

# Achados do Mirror no ALP-CORE-FIN

Data da inspeção: 2026-06-02

## Estrutura observada em `mirror.raw_payloads`

Colunas presentes no schema `mirror`:

* `id` (`uuid`, obrigatória)
* `source` (`text`)
* `external_order_id` (`text`)
* `event_type` (`text`)
* `payload_json` (`jsonb`)
* `headers_json` (`jsonb`)
* `received_at` (`timestamptz`)
* `processed_at` (`timestamptz`)
* `processing_status` (`text`)
* `error_message` (`text`)
* `synced_at` (`timestamptz`)
* `mirror_updated_at` (`timestamptz`)

## Distribuição atual por source

* `anymarket`: 367 registros (`event_type = order`)
* `shopify`: 303 registros (`orders/create` e `orders/paid`)
* `gatea-test-updated`: 1 registro técnico de teste

## Conclusão técnica

O `payload_json` não tem contrato único entre marketplaces. O plano do front deve assumir explicitamente um read model por `source`, com fallback por campo, resolução separada de `marketplace` e exclusão de registros técnicos.

---

# Contrato de Leitura para o Front

As colunas de exibição desejadas são:

* Market Place
* Número do Pedido
* Data
* Forma de Pagamento
* Entrega
* Descontos
* Taxas
* Valor

## Source `anymarket`

Cobertura observada na base atual:

* `marketPlace`: 367/367
* `marketPlaceNumber`: 367/367
* `paymentDate`: 363/367
* `createdAt`: 367/367
* `payments`: 367/367
* `freight`: 367/367
* `discount`: 367/367
* `gross`: 367/367
* `total`: 367/367

Mapeamento recomendado:

* Source lógico: `anymarket`
* Market Place: derivar de `payload_json.marketPlace`
* Número do Pedido: `payload_json.marketPlaceNumber`
* Data: `COALESCE(payload_json.paymentDate, payload_json.createdAt, payload_json.lastUpdate)`
* Forma de Pagamento: priorizar `payload_json.payments[0].paymentMethodNormalized`, fallback para `paymentDetailNormalized`, depois `method`
* Entrega: `payload_json.freight`
* Descontos: `payload_json.discount`
* Taxas: soma de `payload_json.payments[*].marketplaceFee + gatewayFee`
* Valor: `payload_json.total`

Observações:

* `source = anymarket` não define o marketplace final; ele só indica o adaptador. O valor exibido na coluna de marketplace deve sair sempre de `payload_json.marketPlace`.
* Esse grupo pode conter Mercado Livre, Amazon e outros canais suportados pelo AnyMarket; o read model deve aceitar novos valores sem necessidade de alterar a UI.
* `gross` existe em todos os registros, mas para a coluna final de valor a base observada indica `total` como melhor candidato para exibição consolidada.
* `paymentDate` não existe em 4 registros; por isso o fallback para `createdAt` deve ser obrigatório.

## Source `shopify`

Cobertura observada na base atual:

* `source_name`: 303/303
* `name`: 303/303
* `order_number`: 303/303
* `processed_at`: 303/303
* `created_at`: 303/303
* `payment_gateway_names`: 303/303
* `total_shipping_price_set`: 303/303
* `current_total_discounts_set`: 303/303
* `current_total_additional_fees_set`: 303/303
* `total_price`: 303/303

Mapeamento recomendado:

* Source lógico: `shopify`
* Market Place: exibir `Shopify` como valor fixo da coluna de marketplace; `payload_json.source_name` pode ser mantido apenas como canal secundário (`web` na amostra atual)
* Número do Pedido: priorizar `payload_json.name`, fallback para `payload_json.order_number`
* Data: `COALESCE(payload_json.processed_at, payload_json.created_at, payload_json.updated_at)`
* Forma de Pagamento: concatenar `payload_json.payment_gateway_names[]`; se necessário, fallback complementar em `note_attributes` com `_payment_method`
* Entrega: `payload_json.total_shipping_price_set.shop_money.amount`, fallback para `current_shipping_price_set.shop_money.amount`
* Descontos: `payload_json.current_total_discounts_set.shop_money.amount`, fallback para `total_discounts`
* Taxas: somar `payload_json.current_total_additional_fees_set.shop_money.amount` com `payload_json.current_total_tax_set.shop_money.amount`
* Valor: `payload_json.total_price`, fallback para `current_total_price`

Observações:

* `source_name` não deve ser usado sozinho como coluna Market Place, porque a amostra real retorna `web`, não `shopify`.
* `current_total_additional_fees_set` existe no contrato, mas pode vir `null`; o read model precisa tratar isso como zero.
* Em pedidos com múltiplos gateways, a coluna Forma de Pagamento deve suportar composição, não apenas o primeiro item do array.

## Source `gatea-test-updated`

* Não faz parte do domínio financeiro.
* Deve ser filtrado para fora da leitura do front e das métricas de paridade.

---

# Regra de Atualização Contínua do Plano

Ao concluir qualquer atividade da ETAPA 3:

1. Atualizar o status da fase na seção `Status Atual`.
2. Marcar os itens do `Checklist de Execução`.
3. Registrar decisão nova na seção `Decisões Tomadas`.
4. Adicionar linha no `Registro de Andamento` com data, ação e evidência.

Se houver mudança de escopo, atualizar primeiro a seção `Decisões Tomadas` e só então seguir para implementação.

---

# Visão Geral

O Worker será o único componente autorizado a:

* Ler eventos pendentes no ALP-OMS
* Validar payloads
* Aplicar UPSERT no ALP-CORE-FIN
* Registrar falhas
* Controlar retries
* Garantir consistência dos dados

---

# Fluxo de Execução

```text
ALP-OMS
   └── integration.sync_events
            ↓
     Sync Worker
            ↓
 Validação de Evento
            ↓
 Mapeamento de Payload
            ↓
 UPSERT
            ↓
ALP-CORE-FIN.mirror.raw_payloads
            ↓
 Atualização de Status
```

---

# Responsabilidades

## Leitura de Eventos

Buscar eventos pendentes:

```sql
SELECT *
FROM integration.sync_events
WHERE processed = FALSE
ORDER BY id ASC
LIMIT 100;
```

---

## Validação

Validar:

* id
* table_name
* operation
* payload

Rejeitar:

* payload nulo
* JSON inválido
* registros sem id

---

## Sincronização

Realizar UPSERT em:

```text
mirror.raw_payloads
```

Utilizando:

```sql
INSERT ...
ON CONFLICT (id)
DO UPDATE
```

---

## Controle de Status

Ao concluir:

```sql
processed = true
processed_at = now()
```

---

## Tratamento de Falhas

Registrar:

```sql
retries = retries + 1
error_message = erro
```

---

# Arquitetura do Projeto

```text
sync-worker/

├── src/
│
├── config/
│   └── env.js
│
├── database/
│   └── postgres.js
│
├── services/
│   ├── event-reader.js
│   ├── payload-validator.js
│   ├── mirror-sync.js
│   └── event-processor.js
│
├── repositories/
│   ├── oms.repository.js
│   └── core.repository.js
│
├── jobs/
│   └── sync.job.js
│
├── logs/
│
├── package.json
│
└── .env
```

---

# Tecnologias

## Runtime

Node.js 22+

---

## Banco

PostgreSQL

---

## Biblioteca

```bash
npm install pg
```

---

## Variáveis

```bash
npm install dotenv
```

---

## Logs

```bash
npm install pino
```

---

# Variáveis de Ambiente

```env
OMS_DB_URL=

CORE_DB_URL=

BATCH_SIZE=100

SYNC_INTERVAL_MS=5000

MAX_RETRIES=5
```

Observação:

* No MVP com cron, `SYNC_INTERVAL_MS` fica reservado para modo contínuo/local e pode não ser utilizado em produção inicial.

---

# Estrutura das Conexões

## OMS

Responsável por:

* leitura
* atualização dos eventos

---

## CORE

Responsável por:

* UPSERT no mirror

---

# Mapeamento por Operação

| operation (sync_events) | Ação no mirror.raw_payloads |
| --- | --- |
| INSERT | UPSERT por `id` |
| UPDATE | UPSERT por `id` |
| DELETE | DELETE por `id` |

Regra técnica:

* `INSERT` e `UPDATE` aplicam `INSERT ... ON CONFLICT (id) DO UPDATE`
* `DELETE` executa remoção física no mirror para manter paridade com origem

---

# Estratégia de Processamento

## Batch

Processar:

```text
100 registros por ciclo
```

Configuração:

```env
BATCH_SIZE=100
```

---

# Modo de Execução (MVP)

Execução agendada por cron, com processamento one-shot por disparo.

Fluxo por execução:

```text
Disparo do cron
↓
Buscar eventos pendentes (lote)
↓
Processar lote
↓
Marcar sucesso/erro
↓
Finalizar execução
```

---

# UPSERT Oficial

Tabela destino:

```text
mirror.raw_payloads
```

Campos:

```text
id
source
external_order_id
event_type
payload_json
headers_json
received_at
processed_at
processing_status
error_message
```

---

# Controle de Retry

## Política

| Tentativa | Delay    |
| --------- | -------- |
| 1         | imediato |
| 2         | 30s      |
| 3         | 5 min    |
| 4         | 15 min   |
| 5         | 60 min   |

Observação operacional para modo cron:

* O Worker deve respeitar a janela de retry antes de tentar novamente o mesmo evento.
* Ao atingir `MAX_RETRIES`, o evento deve ser encaminhado para DLQ (`integration.failed_jobs`).

---

# Dead Letter Queue

Após:

```text
MAX_RETRIES
```

Mover para:

```text
integration.failed_jobs
```

---

# Observabilidade

Registrar:

* sync_started
* sync_completed
* sync_failed
* retry_attempt
* batch_processed

---

# Logs Estruturados

Formato:

```json
{
  "event":"sync_completed",
  "record_id":"uuid",
  "duration_ms":120,
  "timestamp":"..."
}
```

---

# Métricas

Monitorar:

* eventos processados
* eventos pendentes
* erros
* retries
* latência

---

# Segurança

## Usuário OMS

Permissões:

```sql
SELECT
UPDATE
```

Somente:

```text
integration.sync_events
```

---

## Usuário CORE

Permissões:

```sql
INSERT
UPDATE
SELECT
```

Somente:

```text
mirror.raw_payloads
```

---

# Critérios de Sucesso

O Worker será considerado pronto quando:

* sincronizar INSERTs
* sincronizar UPDATEs
* registrar erros
* executar retries
* suportar reinício sem perda de dados
* manter consistência entre OMS e CORE

---

# Roadmap

## Fase 3.1

MVP

* [x] Estruturar módulo do Worker no repositório
* [x] Configurar variáveis (`OMS_DB_URL`, `CORE_DB_URL`, `BATCH_SIZE`, `MAX_RETRIES`)
* [x] Implementar leitura de pendentes em `integration.sync_events`
* [x] Implementar validação mínima de evento (`id`, `record_id`, `operation`, `payload`)
* [x] Implementar `UPSERT` de `INSERT/UPDATE` em `mirror.raw_payloads`
* [x] Implementar `DELETE` em `mirror.raw_payloads` quando `operation=DELETE`
* [x] Implementar atualização técnica em `integration.sync_events` (sucesso/falha)

---

## Fase 3.2

Robustez

* [x] Implementar logs estruturados de ciclo e item
* [x] Implementar política de retry com backoff
* [x] Implementar DLQ em `integration.failed_jobs`
* [x] Adicionar proteção contra execução concorrente sobreposta
* [x] Expor métricas mínimas no log (processados, falhas, latência, backlog)

---

## Fase 3.3

Produção

* [ ] Definir agendador oficial (cron de plataforma)
* [ ] Empacotar execução (container/process manager)
* [ ] Definir monitoramento e alertas operacionais
* [ ] Publicar runbook de incidentes

---

# Checklist de Execução Técnica

## Banco

* [x] Validar existência de `integration.sync_events` no ALP-OMS
* [x] Validar existência de `mirror.raw_payloads` no ALP-CORE-FIN
* [x] Validar existência de `integration.failed_jobs` para DLQ

## Segurança

* [x] Credencial OMS com `SELECT/UPDATE` apenas em `integration.sync_events`
* [ ] Credencial CORE com `INSERT/UPDATE/SELECT/DELETE` apenas em `mirror.raw_payloads`

## Qualidade

* [x] Teste de INSERT sincronizado
* [x] Teste de UPDATE sincronizado
* [x] Teste de DELETE sincronizado
* [x] Teste de retry até DLQ
* [ ] Teste de reinício sem perda de consistência

---

# Registro de Andamento

| Data | Tipo | Descrição | Evidência |
| --- | --- | --- | --- |
| 2026-06-02 | decisão | ETAPA 3 focada apenas em `mirror.raw_payloads` | alinhamento funcional |
| 2026-06-02 | decisão | Execução MVP será por cron (one-shot) | alinhamento técnico |
| 2026-06-02 | decisão | `DELETE` remove no mirror | alinhamento funcional |
| 2026-06-02 | decisão | Escrita no ALP-OMS restrita a `integration.sync_events` | política de segurança |
| 2026-06-02 | entrega | Worker one-shot inicial implementado | `src/workers/sync/run-once.ts` |
| 2026-06-02 | entrega | Repositórios OMS/CORE implementados para leitura/sync/ack | `src/workers/sync/repositories/*.ts` |
| 2026-06-02 | entrega | Configuração de ambiente e script de execução adicionados | `.env.example`, `package.json` |
| 2026-06-02 | validação | Checks de qualidade locais executados com sucesso | `npm run typecheck`, `npm run check:boundaries`, `npm run check:contracts` |
| 2026-06-02 | validação | Execução real do worker em ambiente configurado concluída com sucesso | `npm run worker:sync:once` (fetched=100, processed=100, failed=0) |
| 2026-06-02 | decisao | Criterio formal de sinal verde para cutover ALP-CORE-FIN definido | secao "Sinal Verde de Go-Live (ALP-CORE-FIN)" |
| 2026-06-02 | entrega | Infra técnica de robustez adicionada no OMS (`next_retry_at`, `integration.failed_jobs`) | `OmsRepository.ensureInfrastructure()` |
| 2026-06-02 | validação | Backoff validado com evento de teste (retry 2 -> 3 com `next_retry_at` futuro) | `record_id=gatea-backoff-*` |
| 2026-06-02 | validação | DLQ validada com falha real ao atingir `MAX_RETRIES` | `DLQ_LAST_REORDER sync_event_id=3884` |
| 2026-06-02 | validação | Lock concorrente validado (execução skip com lock ocupado) | log `sync_skipped_lock_busy` |
| 2026-06-02 | validação | Teste funcional INSERT sincronizado | `INSERT_FIXED_MIRROR source=gatea-test` |
| 2026-06-02 | validação | Teste funcional UPDATE sincronizado | `UPDATE_FIXED_MIRROR source=gatea-test-updated` |
| 2026-06-02 | validação | Teste funcional DELETE sincronizado | `DELETE_FIXED_MIRROR_COUNT=0` |
| 2026-06-02 | entrega | Script de baseline de paridade criado | `scripts/gate-b-baseline.ts` |
| 2026-06-02 | validação | Baseline inicial da Fase 4.1 coletado | `npm run gate:b:baseline` |
| 2026-06-02 | entrega | Read model financeiro via mirror implementado (source + marketplace) | `src/features/transactions/read-model.ts` |
| 2026-06-02 | entrega | Listagem de transações migrada para read model (com fallback por env) | `src/features/transactions/repository.ts` |
| 2026-06-02 | entrega | Fluxo de caixa e dashboard passaram a consumir read model quando habilitado | `src/features/cash-flow/service.ts` |
| 2026-06-02 | validação | Typecheck após implementação da Fase 4.4 | `npm run typecheck` |
| 2026-06-02 | validação | Validacao visual inicial concluida no sistema (Dashboard e Fluxo de Caixa) | `http://localhost:3000/financeiro/dashboard`, `http://localhost:3000/financeiro/fluxo-de-caixa` |
| 2026-06-02 | entrega | Plano dedicado de regularizacao do ALP-CORE-FIN criado para execucao da Fase 4.2 | `docs/PLAN-REGULARIZA-ALP-CORE-FIN.md` |

---

# ETAPA 4 - Cutover para ALP-CORE-FIN

Objetivo: concluir Gate B e Gate C para permitir sinalizacao final de prontidao sem perda de funcionalidade, agora considerando migracao total do sistema para ALP-CORE-FIN.

## Fase 4.1 - Escopo e aceite do cutover

* [x] Confirmar que a ingestao Shopify direta no app atual sera desativada
* [x] Confirmar que a exibicao de transacoes deve ler `mirror.raw_payloads.payload_json`
* [x] Confirmar que `source` e `marketplace` sao conceitos distintos no read model
* [ ] Formalizar criterios finais de aceite por tela e endpoint

## Fase 4.2 - Bootstrap completo do ALP-CORE-FIN

* [ ] Executar migracoes Prisma no ALP-CORE-FIN para schema completo atual (User/Auth + financeiro + suporte operacional)
* [ ] Validar presenca e integridade das tabelas criticas do app atual
* [ ] Ajustar seed inicial para admins e dados minimos no ALP-CORE-FIN
* [ ] Validar constraints e indices usados pelas queries atuais
* [x] Formalizar plano operacional de regularizacao para guiar execucao, evidencias e criterio de saida (`docs/PLAN-REGULARIZA-ALP-CORE-FIN.md`)

## Fase 4.3 - Desativacao da ingestao Shopify no app

* [ ] Desligar endpoint de webhook Shopify para impedir novas gravacoes diretas no app atual
* [ ] Desligar endpoint de sync manual Shopify para impedir novas escritas diretas em `FinancialTransaction`
* [ ] Preservar observabilidade das chamadas desativadas com retorno controlado e log estruturado
* [ ] Atualizar documentacao operacional e variaveis de ambiente relacionadas a esse fluxo

## Fase 4.4 - Read model de transacoes via mirror

* [x] Criar repositorio de leitura dedicado para projetar `payload_json` em colunas de exibicao do financeiro
* [x] Implementar mapeamento tipado separando `source` de `marketplace`
* [x] Implementar filtros equivalentes aos atuais: periodo, tipo, source, marketplace, payment method, busca e paginacao
* [x] Integrar o novo read model na listagem de transacoes usada por paginas e APIs financeiras

## Fase 4.5 - Adaptacao dos servicos financeiros

* [x] Refatorar fluxo de caixa para a nova fonte de leitura
* [x] Refatorar dashboard para a nova fonte de leitura
* [ ] Refatorar reconciliacao para a nova fonte de leitura
* [ ] Validar lancamentos manuais e importacoes no ALP-CORE-FIN com exibicao correta nas telas

## Fase 4.6 - Paridade funcional (Gate B)

* [x] Definir baseline funcional atual (fluxo de caixa, dashboard, reconciliacao, importacoes, lancamentos)
* [x] Validacao visual inicial de Dashboard e Fluxo de Caixa apos implementacao da Fase 4.4
* [ ] Executar smoke tests nos endpoints financeiros principais com dados reais
* [ ] Comparar resultados entre comportamento atual e leitura pelo mirror
* [ ] Registrar diferencas, corrigir e revalidar ate paridade

Snapshot inicial (2026-06-02T19:14:05.637Z):

* app.totalTransactions: 32586
* app.incomeCents: 588171791
* app.outcomeCents: 0
* app.balanceCents: 588171791
* app.txLast30d: 32091
* app.incomeLast30d: 577159562
* app.outcomeLast30d: 0
* app.totalBatches: 0
* app.totalWebhooks: 30008
* mirror.totalRawPayloads: 671

Comando operacional:

* `npm run gate:b:baseline`

## Fase 4.7 - Cutover seguro (Gate C)

* [ ] Eliminar variaveis duplicadas e fixar ALP-CORE-FIN como fonte oficial da aplicacao
* [ ] Validar comportamento pos-cutover em API e UI
* [ ] Executar plano de rollback em teste controlado
* [ ] Aprovar janela curta de observacao com monitoramento de erro, backlog e integridade dos dados exibidos

## Fase 4.8 - Estabilizacao

* [ ] Monitorar 24-72h com alertas operacionais
* [ ] Confirmar ausencia de regressao funcional
* [ ] Publicar status final "PRONTO PARA ALP-CORE-FIN" quando Gates B e C estiverem completos

---

# Resultado Esperado

```text
Shopify/Marketplaces
   ↓
ALP-OMS.raw_payloads
   ↓
Trigger
   ↓
integration.sync_events
   ↓
Sync Worker
   ↓
ALP-CORE-FIN.mirror.raw_payloads
```

Com sincronização contínua, segura, auditável e preparada para crescimento futuro.
