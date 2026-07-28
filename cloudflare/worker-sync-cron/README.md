# Cloudflare Worker Cron - Sync Trigger

Este worker agenda e dispara tres endpoints internos, um por cron
configurado em `wrangler.jsonc` (`triggers.crons`), roteados em `scheduled()`
via `controller.cron`:
- `*/5 * * * *` -> GET /api/internal/cron/worker-sync (sync OMS -> mirror)
- `*/20 * * * *` -> GET /api/internal/cron/shopify-payment-resolution
  (resolve o gateway titular de pedidos Shopify pagos, em lotes pequenos
  escopados aos ultimos dias — nao o backlog historico inteiro)
- `0 * * * *` -> GET /api/internal/cron/shopify-verify (compara Sistema
  Financeiro x Shopify para o dia anterior; loga divergencia e, se o dia
  ja estiver maduro o suficiente, tenta auto-alinhar rodando a resolucao de
  gateway para aquele dia)

## 1) Pre-requisitos

- Conta Cloudflare com Workers habilitado
- Wrangler autenticado localmente
- URL de producao da aplicacao
- Mesmo valor de CRON_SECRET usado na aplicacao (Vercel)

## 2) Configurar variaveis

Edite APP_BASE_URL no arquivo wrangler.jsonc.

Defina o secret no Cloudflare:

wrangler secret put CRON_SECRET

Opcional:
- WORKER_CRON_DAYS: 30, 60 ou 90 (default: 30) — usado pelo sync OMS->mirror
- SHOPIFY_RESOLUTION_BATCH_SIZE: tamanho do lote da resolucao de gateway (default: 150)
- SHOPIFY_RESOLUTION_SINCE_DAYS: janela em dias da resolucao de gateway (default: 3)

## 3) Deploy

No diretorio cloudflare/worker-sync-cron:

wrangler deploy

## 4) Validacao

- Execute manualmente no dashboard do Cloudflare (Trigger Event) ou aguarde o cron.
- Verifique se o endpoint interno retorna sucesso e cria job.
- Em caso de erro, o worker falha com status e body da resposta.
