# Plano de Implementacao - Sistema Financeiro

## Objetivo
Construir um app financeiro separado para fluxo de caixa, dashboard consolidado, importacao de planilhas e previsao de entrada liquida por marketplace.

## Escopo confirmado
- Integracao com endpoints financeiros do sistema atual
- Ingestao por webhooks Shopify com HMAC e idempotencia
- Lancamentos manuais e importacao de CSV
- Cadastro/importacao de taxas por marketplace (Shopify, Mercado Livre, Shopee e Amazon)
- Projecao de caixa com base em bruto, taxas e liquido
- Reconciliacao de dados e observabilidade

## Definicoes tecnicas obrigatorias
- Envelope de API padrao: success, data, error, requestId, meta
- ActionResult para actions server-side
- Controle de acesso por role admin/financeiro
- Rate limit por endpoint sensivel
- RequestId obrigatorio em respostas e logs
- Janela temporal com dias completos (00:00:00.000 -> 23:59:59.999)

---

## Sprint 1 — Fundacao [CONCLUIDO]

- [x] Story 1.1 Bootstrap do projeto (Next.js 16, TypeScript, Prisma, Tailwind)
- [x] Story 1.2 Guardrails arquiteturais (check-boundaries, check-contracts)
- [x] Story 1.3 Padrao operacional CLAUDE/agents
- [x] Story 2.1 Autenticacao e autorizacao por role (middleware + withApiSecurity)
- [x] Story 2.2 Seguranca de API e observabilidade minima (logger, telemetria, rate limit)
- [x] Story 4.1 Modelo base de transacoes — CRUD completo (repository, actions, validations, API route)

**Schema criado**: FinancialTransaction, TransactionCategory, ImportBatch, ReconciliationSnapshot

---

## Sprint 2 — Integracoes [CONCLUIDO]

- [x] Webhook Shopify: verificacao HMAC-SHA256 com timingSafeEqual
- [x] Idempotencia por eventId (model WebhookEvent)
- [x] Mapeamento orders/paid + orders/create -> FinancialTransaction
- [x] Atomicidade via $transaction Prisma
- [x] API route POST /api/webhooks/shopify
- [x] UI basica /integracoes (listagem de eventos)

**Schema adicionado**: WebhookEvent
**Variavel de ambiente**: SHOPIFY_WEBHOOK_SECRET

---

## Sprint 3 — Fluxo de Caixa + Taxas [CONCLUIDO]

- [x] Model MarketplaceFee (marketplace, feeType, ratePercent, fixedCents, effectiveFrom/Until)
- [x] feature/marketplace-fees: types, repository, validations, actions
- [x] API GET+POST /api/financial/marketplace-fees
- [x] feature/cash-flow: tipos, service (calculo por periodo com raw SQL), actions
- [x] API GET /api/financial/cash-flow
- [x] API GET /api/financial/dashboard (real — substituiu placeholder)
- [x] UI /fluxo-de-caixa: cards de totais + breakdown por origem + comparativo de periodo
- [x] Deploy na Vercel + banco Supabase + migracao inicial aplicada

**Schema adicionado**: MarketplaceFee
**Variaveis de ambiente**: DATABASE_URL, DIRECT_URL, SHOPIFY_WEBHOOK_SECRET

---

## MVP Funcional — Sprint 4 [EM ANDAMENTO]

Objetivo: sistema funcional de ponta a ponta com login, importacao, dashboard completo e reconciliacao.

### Fase A — Autenticacao Supabase Auth [CONCLUIDO]

- [x] Instalar @supabase/supabase-js e @supabase/ssr
- [x] src/core/auth/supabase-server.ts — client para Server Components
- [x] src/core/auth/supabase-client.ts — client para browser
- [x] src/app/login/page.tsx — formulario email + senha
- [x] Atualizar middleware.ts — verificar sessao Supabase via cookie, injetar x-user-* nos headers
- [x] src/app/api/auth/callback/route.ts — troca code por sessao
- [x] src/app/api/auth/logout/route.ts — signOut + redirect para /login
- [x] Atualizar (financeiro)/layout.tsx — exibir email logado + botao logout
- [x] src/app/(financeiro)/page.tsx — dashboard index com links

**Variaveis necessarias**: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
**Decisao**: role armazenada em user_metadata.role no Supabase
**Nota**: chave nomeada PUBLISHABLE_KEY (nova convencao Supabase) e nao ANON_KEY

### Fase B — Pipeline de Importacao CSV [CONCLUIDO]

- [x] Model ImportBatchRow no schema.prisma (relacao Cascade com ImportBatch)
- [x] src/features/imports/types.ts
- [x] src/features/imports/csv-parser.ts — parse zero-dependencia (DD/MM/AAAA, valores BRL)
- [x] src/features/imports/repository.ts — createBatch, findByHash, listBatches, commitBatch, rollbackBatch
- [x] src/features/imports/actions.ts — previewImportAction, commitImportAction, rollbackImportAction
- [x] Atualizar API /api/financial/imports — GET (listar) + POST (upload multipart + commit/rollback JSON)
- [x] UI /importacoes — upload, preview, confirmar/cancelar + historico de lotes

**Colunas CSV**: data, tipo, valor, descricao, categoria, origem
**Garantia**: dedupe por hash do arquivo (idempotencia via fileHash unique)
**Nota**: migration add-import-batch-row pendente de aplicar com DIRECT_URL configurado

### Fase C — Dashboard UI completo [CONCLUIDO]

- [x] src/app/(financeiro)/dashboard/page.tsx — cards + barra proporcional + tabela por marketplace + comparativo de periodo
- [x] Seletor de periodo (7/30/90 dias) via searchParams
- [x] Links Dashboard adicionados em layout e indice do financeiro

### Fase D — Reconciliacao [REMOVIDO]

Implementada e depois **removida no commit `8195b57`** (decisao do time): a
feature so verificava dados manuais/importados via Prisma, nunca o mirror
onde vivem os pedidos reais de Shopify/Anymarket. Fica para uma versao futura
com escopo que cubra o mirror — ver validacao de valores/transacoes Sistema x
Shopify via `npm run verify:shopify` e o job de resolucao de gateway
(`src/features/integration/shopify-payment-resolution-job.ts`) como o
caminho atual de verificacao contra a Shopify.

- [x] ~~src/features/reconciliation/types.ts — ReconciliationIssue, IssueType~~ (removido)
- [x] ~~src/features/reconciliation/service.ts — 5 verificacoes: duplicatas, sem categoria, saldo negativo, orphan import rows, webhooks nao processados~~ (removido)
- [x] ~~src/features/reconciliation/actions.ts — runReconciliationAction~~ (removido)
- [x] ~~API /api/financial/reconciliation — GET e POST executam e persistem ReconciliationSnapshot~~ (removido)
- [x] ~~UI /reconciliacao — resumo de issues por severidade com seletor de periodo~~ (removido)

Tambem removido no mesmo commit: `marketplace-fees` (codigo morto, nunca
conectado ao calculo real de `feeCents`).

---

## Backlog (pos-MVP)

- Importacao de formato especifico por marketplace (Shopify, ML, Shopee, Amazon)
- Projecao de caixa futuro aplicando taxas cadastradas
- Lançamentos manuais via UI
- Convite de usuarios com role pre-definida
- Exportacao de relatorio PDF/CSV
- Integracoes adicionais (Mercado Livre, Shopee)
