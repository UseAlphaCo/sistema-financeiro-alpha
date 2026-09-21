<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Guia do repositorio

Sistema financeiro em Next.js (App Router) com foco em fluxo de caixa, previsao
de entrada liquida por marketplace e reconciliacao de dados. O sistema nao
origina vendas: espelha os pedidos do OMS (Supabase de outro time, somente
leitura), materializa um read model proprio e apresenta o resultado nas telas.

Contexto completo em `README.md`. Charter operacional em `CLAUDE.md`.

## Estrutura do projeto

- `src/app/(app)/`: telas — dashboard, fluxo de caixa, lancamentos, importacoes,
  integracoes, usuarios, alterar senha.
- `src/app/api/`: `financial/*` (autenticada por sessao + role),
  `internal/cron/*` (autenticada por `CRON_SECRET`), `webhooks/shopify`,
  `health`.
- `src/core/`: auth, seguranca, observabilidade, cache, db, query, store, erros.
- `src/features/`: dominio — `cash-flow`, `transactions`, `integration`,
  `imports`, `categories`, `users`.
- `src/shared/`: envelope de API e configuracao compartilhada.
- `src/types/`: contratos transversais (`ApiEnvelope`, `ActionResult`, roles).
- `src/workers/sync/`: varredura OMS -> mirror (cursor fisico, retry, piso).
- `src/proxy.ts`: middleware — rotas protegidas, roles e freeze de manutencao.
- `cloudflare/worker-sync-cron/`: agendador que dispara os crons internos.
- `prisma/`: schema e migracoes da base da aplicacao.
- `scripts/` e `scripts/sql/`: operacao, diagnostico e SQL avulso.
- `docs/`: planos, backlogs, runbooks, arquitetura e features.

## Comandos

```bash
npm run dev
npm run check            # lint + typecheck + boundaries + contracts + test + build
npm run test             # Vitest (src/**/*.test.ts), TZ=UTC fixo
npm run prisma:generate
npm run prisma:seed
npm run worker:sync:once
npm run resolve:shopify-gateway
npm run verify:shopify
```

Nao invente comandos: `package.json` e a fonte de verdade. Nao existe coverage,
e2e, lint-staged, commitlint nem hook de Husky neste projeto.

## Padroes e convencoes

- TypeScript strict, ESM, indentacao de 2 espacos, imports por alias `@/`.
- Nomes de simbolos e arquivos em ingles; comentarios e documentacao em pt-BR.
- Toda rota de API responde no envelope `ApiEnvelope<T>`
  (`success`, `data`, `error`, `requestId`, `meta`).
- Server actions devolvem `ActionResult<T>`; erros de dominio usam `AppError`.
- Rotas sensiveis passam por `withApiSecurity` (auth, role, rate limit,
  `requestId`).
- Validacao de entrada com Zod, na fronteira.
- Respeite as fronteiras de camada: `shared` nao importa `core` nem `features`;
  `core` nao importa `features`. `npm run check:boundaries` bloqueia.

## Testes

- Vitest colocalizado com o codigo (`src/features/**`, `src/workers/**`,
  `src/lib/**`).
- `TZ=UTC` e fixado em `vitest.config.ts` de proposito: as fronteiras de dia do
  sistema sao `America/Sao_Paulo` por literal. Teste que passa so porque a
  maquina esta em horario de Brasilia esconde o defeito.
- Mudanca em mapeamento de pedido, filtro de data ou read model exige teste
  novo ou ajustado.

## Regras criticas de dados

- **OMS e somente leitura.** Nenhuma escrita, indice, trigger ou migracao no
  projeto do outro time. Toda escrita vai para o CORE-FIN.
- **Recorte de dia sempre em `America/Sao_Paulo`**, via `src/lib/date-utils.ts`.
- **Idempotencia obrigatoria**: importacoes por hash/lote, eventos de webhook
  por `eventId`, jobs de sync pela fila em `integration.sync_queue`.
- **Falha de sync vai para a DLQ** (`integration.failed_jobs`), nunca para log
  silencioso.
- **Cadencia de cron e orcamento de CPU da Vercel**, nao preferencia. Aumentar
  frequencia ou trafegar `payload_json` inteiro estoura a cota — ver o
  comentario de `triggers` em `cloudflare/worker-sync-cron/wrangler.jsonc`.
- **Vazio na tela nao e zero**: abaixo de `SYNC_MIRROR_FLOOR_AT` nao existe
  dado, e as telas devem dizer isso.
- **Nao trate defasagem como divergencia**: o dia corrente fecha em ~78% quando
  materializado a noite; o passe de D-1 as 06:30 BRT e quem corrige.

## Seguranca

- `/api/financial/*` exige sessao e role `admin` ou `financeiro`.
- `/api/internal/cron/*` autentica por `CRON_SECRET` (mesmo valor na Vercel e no
  secret do worker Cloudflare).
- Webhook Shopify valida HMAC antes de qualquer processamento.
- Nunca logar PII nem payload financeiro cru; aplicar redacao.
- Segredos apenas em variaveis de ambiente. Nunca comitar `.env*` real nem citar
  valor de segredo em codigo, doc ou mensagem de commit.

## Commits e pull requests

- Conventional Commits, com titulo e descricao em **portugues do Brasil**.
  Escopos seguem o historico: `feat(read-model)`, `fix(telas)`, `fix(crons)`,
  `perf(crons)`, `fix(sync)`, `ops(proxy)`, `docs`, `chore(scripts)`.
- Nomes tecnicos (escopos, arquivos, tipos, identificadores) podem ficar em
  ingles.
- **Nao incluir trailer `Co-Authored-By` do Claude** neste repositorio.
- Rodar `npm run check` antes de commitar.
- Mudanca que toca banco ou rede precisa de teste real (`npm run dev` + chamada
  de verdade) antes do commit, nao apenas script isolado.

## Limites de atuacao dos agentes

- **Nao dar push e nao abrir PR.** Publicar e decisao do usuario; commits ficam
  locais e podem ser desfeitos.
- **Nao rodar migracao destrutiva, truncate ou reset de mirror** sem pedido
  explicito. Os runbooks em `docs/RUNBOOK-*.md` descrevem esses procedimentos.
- **Nao escrever no OMS** em nenhuma hipotese.
- **Nao mexer em cadencia de cron nem em flag de read model** sem dizer qual
  cota ou qual fonte de verdade muda com isso.
- **Nao inventar infraestrutura**: se um servico, tabela ou variavel nao existe
  no repositorio, registre como nao definido em vez de assumir.
- Ao alterar comportamento, atualizar a doc de feature correspondente em `docs/`.

## Documentacao de referencia

- `docs/architecture/ARCHITECTURE-OVERVIEW.md` e
  `docs/architecture/CONTEXT-TREE.md`
- `docs/PLAN-IMPLEMENTACAO.md` e `docs/PLAN-IMPLEMENTACAO-v0-2.md`
- `docs/features/feature-read-model-mirror.md` (mapeamento do `payload_json`)
- `docs/MAPA-OPERACIONAL-SYNC-OMS-MIRROR.md`
- `docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md`
- `docs/RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md`,
  `docs/RUNBOOK-DUMP-OMS-E-SYNC-CORE-10DIAS.md`,
  `docs/RUNBOOK-RESET-MIRROR-AGOSTO-2026.md`
