# Sistema Financeiro

Aplicacao Next.js para gestao financeira com foco em fluxo de caixa, previsao de
entrada liquida por marketplace e reconciliacao/rastreabilidade de dados.

O sistema nao origina vendas: ele espelha os pedidos do OMS (projeto Supabase de
outro time, lido em modo somente-leitura), projeta esses pedidos em um read model
proprio e apresenta o resultado nas telas financeiras.

## Estagio atual (v0.1.0)

- Producao na Vercel, com dominio `phi.usealphaco.com.br`.
- Ingestao OMS -> `mirror.raw_payloads` por varredura de cursor fisico (`ctid`),
  agendada de 3 em 3 horas. O cursor de tempo foi abandonado: sem indice no OMS
  ele falha por construcao.
- Leitura das telas pela tabela materializada `integration.financial_orders` por
  omissao (`FINANCIAL_READ_MODEL_MATERIALIZED !== "false"`); o mirror ao vivo
  continua disponivel como caminho de fallback sem redeploy.
- Piso de cobertura de dados em `2026-08-01` (`SYNC_MIRROR_FLOOR_AT`): antes
  dessa data as telas anotam "sem dado" em vez de mostrar zero.
- Webhook Shopify desativado (retorna `410`) enquanto o mirror e a fonte de
  verdade; a resolucao de gateway titular roda por job proprio contra a Admin
  API.
- Freeze de manutencao (`MAINTENANCE_MODE`) desligado por omissao: o deploy
  reabre o sistema, e ligar o freeze e uma decisao explicita.
- Cadencia de crons e orcamento de CPU, nao preferencia: o plano gratuito de
  Fluid Active CPU da Vercel foi estourado em um dia com o sync a cada 15 min.

## Arquitetura

| Camada | Caminho | Funcao |
|---|---|---|
| Telas | `src/app/(app)/` | Dashboard, fluxo de caixa, lancamentos, importacoes, integracoes, usuarios |
| API | `src/app/api/` | `financial/*` (autenticada), `internal/cron/*` (por segredo), `webhooks/*`, `health` |
| Core | `src/core/` | Auth, seguranca, observabilidade, cache, db, query, store, erros |
| Features | `src/features/` | Dominio: `cash-flow`, `transactions`, `integration`, `imports`, `categories`, `users` |
| Shared | `src/shared/` | Envelope de API e configuracao compartilhada (nao importa core nem features) |
| Types | `src/types/` | Contratos transversais (`ApiEnvelope`, `ActionResult`, roles) |
| Worker de sync | `src/workers/sync/` | Varredura OMS -> mirror, cursor, retry, piso |
| Agendador | `cloudflare/worker-sync-cron/` | Cloudflare Worker que dispara os crons internos por HTTP |
| Banco | `prisma/` | Schema Prisma da app + migracoes |
| Scripts | `scripts/` | Operacao, diagnostico, backfill e SQL avulso |
| Documentacao | `docs/` | Planos, backlogs, runbooks, arquitetura e features |

### Bases de dados

| Base | Papel | Acesso |
|---|---|---|
| OMS (`OMS_DB_URL`) | Origem dos pedidos (`public.raw_payloads`) | Somente leitura, de outro time |
| CORE-FIN (`CORE_DB_URL`) | `mirror.raw_payloads`, `integration.*` (fila, DLQ, cursor, materializacao) | Leitura e escrita, conexao direta |
| App (`DATABASE_URL`) | Tabelas Prisma: usuarios, categorias, importacoes, snapshots | Leitura e escrita, via pooler |

## Estrutura do repositorio

```text
.
├── src/
│   ├── app/
│   │   ├── (app)/
│   │   └── api/
│   ├── core/
│   ├── features/
│   ├── shared/
│   ├── types/
│   ├── workers/sync/
│   ├── lib/
│   └── proxy.ts
├── cloudflare/worker-sync-cron/
├── prisma/
├── scripts/
│   └── sql/
├── docs/
│   ├── architecture/
│   ├── features/
│   └── shopify/
└── .github/workflows/
```

## Requisitos

- Node.js `20.x`
- npm `>= 10`
- Acesso aos projetos Supabase do OMS (leitura) e do CORE-FIN (escrita)
- Wrangler CLI (apenas para o agendador Cloudflare)

## Setup local

```bash
# 1) Dependencias (roda prisma generate no postinstall)
npm install

# 2) Ambiente
cp .env.example .env
# preencher DATABASE_URL, DIRECT_URL, NEXTAUTH_SECRET, OMS_DB_URL,
# CORE_DB_URL, CRON_SECRET e os valores de Shopify

# 3) Banco da app
npm run prisma:generate
npm run prisma:seed

# 4) Servidor de desenvolvimento
npm run dev
```

As variaveis de ambiente estao documentadas uma a uma em `.env.example`. Duas
que mudam o comportamento das telas e nao aparecem la:
`FINANCIAL_READ_MODEL_MATERIALIZED` e `SYNC_MIRROR_FLOOR_AT`.

## Comandos principais

```bash
# Desenvolvimento
npm run dev
npm run build
npm run start

# Gates de qualidade (mesma ordem do CI)
npm run lint
npm run typecheck
npm run check:boundaries
npm run check:contracts
npm run test
npm run check              # roda todos acima + build

# Banco
npm run prisma:generate
npm run prisma:seed

# Operacao
npm run worker:sync:once       # uma volta do sync OMS -> mirror
npm run resolve:shopify-gateway
npm run verify:shopify
npm run gate:b:baseline
```

Nao existe comando de coverage, e2e ou lint-staged neste projeto. Os testes sao
Vitest colocalizados (`src/**/*.test.ts`) e rodam com `TZ=UTC` fixo, para nao
esconder erro de fuso.

## Agendador de crons (Cloudflare)

Os crons vivem em `cloudflare/worker-sync-cron/wrangler.jsonc`, e cada expressao
e tambem a chave do switch em `cloudflare/worker-sync-cron/src/index.ts` —
mudar uma sem a outra
faz o cron cair no `default` e apenas lancar erro.

```bash
cd cloudflare/worker-sync-cron

# Segredo compartilhado com a aplicacao (mesmo valor de CRON_SECRET na Vercel)
wrangler secret put CRON_SECRET

wrangler deploy
```

| Cron (UTC) | Endpoint interno | Papel |
|---|---|---|
| `0 */3 * * *` | `/api/internal/cron/worker-sync` | Sync OMS -> mirror por cursor de pagina |
| `0 */2 * * *` | `/api/internal/cron/shopify-payment-resolution` | Gateway titular dos ultimos dias |
| `0 9 * * *` | `/api/internal/cron/shopify-verify` | Verificacao Sistema x Shopify sobre D-1 |
| `0 2 * * *`, `30 9 * * *`, `30 2 * * *` | `/api/internal/cron/materialize-orders` | Materializacao de D-0, D-1 e D-2 |

Alterar cadencia exige checar o orcamento de CPU da Vercel antes: ver o
comentario de `triggers` no `wrangler.jsonc`.

## Seguranca e governanca

### Contratos obrigatorios

Validados por `npm run check:contracts`:

- `ActionResult<T>` e `ApiEnvelope<T>` em `src/types/api.ts`
- `AppError` em `src/core/errors/app-error.ts`
- `withApiSecurity` em `src/core/security/with-api-security.ts`, mantendo
  suporte a `rateLimit` e `requestId`
- `src/proxy.ts` presente

### Regras de fronteira

Validadas por `npm run check:boundaries`:

- `src/shared/` nao pode importar `core` nem `features`
- `src/core/` nao pode importar `features`
- `features` podem importar `core`, `shared` e `types`

### Autenticacao e autorizacao

- Rotas `/api/financial/*` e as paginas protegidas passam por `src/proxy.ts`.
- Autorizacao por role: apenas `admin` e `financeiro` acessam o financeiro.
- Rotas `/api/internal/cron/*` autenticam por `CRON_SECRET`, nao por sessao.
- Webhook Shopify valida HMAC (`src/core/security/verify-shopify-hmac.ts`).
- Toda requisicao sensivel carrega `requestId`; logs aplicam redacao de campos
  sensiveis.

### CI

`.github/workflows/ci.yml` roda em push para `main`/`develop` e em pull request:
`lint`, `typecheck`, `check:boundaries`, `check:contracts`, `test`, `build` — a
mesma sequencia de `npm run check`.

## Criticidade de dados

- **Fronteira de dia**: recorte sempre em `America/Sao_Paulo` por literal, nunca
  no fuso do processo. Ver `src/lib/date-utils.ts`.
- **OMS e read-only**: nenhuma escrita, nenhum indice, nenhum trigger no projeto
  do outro time.
- **Idempotencia**: importacoes por hash/lote; eventos de webhook por `eventId`.
- **Falhas de sync** vao para `integration.failed_jobs` (DLQ, retencao em
  `DLQ_RETENTION_DAYS`), nao para log.
- **Completude**: o dia corrente nunca esta fechado quando materializado a noite;
  as telas anotam ate onde os dados vao em vez de fingir total.

## Documentacao

- Arquitetura: `docs/architecture/ARCHITECTURE-OVERVIEW.md`,
  `docs/architecture/CONTEXT-TREE.md`
- Plano vigente: `docs/PLAN-IMPLEMENTACAO.md`, `docs/PLAN-IMPLEMENTACAO-v0-2.md`
- Features: `docs/features/feature-cash-flow.md`,
  `docs/features/feature-imports.md`,
  `docs/features/feature-read-model-mirror.md`,
  `docs/feature-lancamentos-categorias.md`
- Sync e mirror: `docs/MAPA-OPERACIONAL-SYNC-OMS-MIRROR.md`,
  `docs/PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md`
- Shopify: `docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md`,
  `docs/shopify/shopify-payments-by-gateway.md`
- Runbooks: `docs/RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md`,
  `docs/RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md`,
  `docs/RUNBOOK-RESET-MIRROR-AGOSTO-2026.md`

## Troubleshooting rapido

- **Falha no CI**: rode `npm run check` e corrija o primeiro gate que quebrar.
- **Telas vazias em periodo antigo**: confira `SYNC_MIRROR_FLOOR_AT`. Abaixo do
  piso nao existe dado, e isso e diferente de "nao vendeu".
- **Numeros defasados**: veja quando a materializacao rodou. D-0 fecha em ~78%;
  o passe de D-1 as 06:30 BRT e quem corrige.
- **Divergencia contra a Shopify**: rode `npm run verify:shopify`; se for gateway
  nao resolvido, `npm run resolve:shopify-gateway`.
- **Cron devolvendo 503**: `MAINTENANCE_MODE="true"` continua definido na Vercel
  — `/api/internal` esta em `FROZEN_API_PREFIXES`.
- **Sync sem avancar**: cheque `integration.sync_scan_cursor` e
  `integration.failed_jobs`; o lock e advisory e exige conexao direta, nao o
  pooler.

## Licenca

Projeto privado. Sem licenca publica definida.
