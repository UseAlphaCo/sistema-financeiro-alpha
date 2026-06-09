# Cloudflare Worker Cron - Sync Trigger

Este worker agenda e dispara o endpoint interno de sincronizacao:
- GET /api/internal/cron/worker-sync

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
- WORKER_CRON_DAYS: 30, 60 ou 90 (default: 30)

## 3) Deploy

No diretorio cloudflare/worker-sync-cron:

wrangler deploy

## 4) Validacao

- Execute manualmente no dashboard do Cloudflare (Trigger Event) ou aguarde o cron.
- Verifique se o endpoint interno retorna sucesso e cria job.
- Em caso de erro, o worker falha com status e body da resposta.
