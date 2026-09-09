# Cloudflare Worker Cron - Sync Trigger

Este worker agenda e dispara quatro endpoints internos, um por cron
configurado em `wrangler.jsonc` (`triggers.crons`), roteados em `scheduled()`
via `controller.cron`.

**As expressoes vivem em dois arquivos e precisam ser iguais caractere a
caractere:** `wrangler.jsonc` registra o gatilho, `src/index.ts` usa a mesma
string como chave de despacho. Divergir nao quebra o deploy — o cron cai no
`default` e so lanca erro nos logs do Cloudflare, entao o trabalho para em
silencio. `src/cron-schedule.test.ts` compara os dois arquivos e roda no
`npm run check`.

## Agenda (UTC -> BRT)

| UTC | BRT | Rota | Papel |
|---|---|---|---|
| `0 1,4,7,10,13,16,19,22 * * *` | 22,01,04,07,10,13,16,19 | `worker-sync` | sync OMS -> mirror por cursor fisico (8/dia) |
| `0 */2 * * *` | de 2 em 2 h | `shopify-payment-resolution` | gateway titular, lotes pequenos dos ultimos dias (12/dia) |
| `15 13 * * *` | 10:15 | `shopify-payment-resolution` | passe de fechamento, lote maior, drena a fila (1/dia) |
| `0 2 * * *` | 23:00 | `materialize-orders` | D-0 |
| `30 10 * * *` | 07:30 | `materialize-orders` | D-1, tela da manha |
| `40 13 * * *` | 10:40 | `materialize-orders` | D-1, fechamento |
| `30 2 * * *` | 23:30 | `materialize-orders` | D-2, rede de seguranca |
| `50 13 * * *` | 10:50 | `shopify-verify` | confere D-1 contra a Shopify e emite o recibo |

## A janela da manha e uma corrente

A meta e **"as 11:00 BRT, D-1 materializado e reconciliado"**. Ela nao se cumpre
por cada cron ser rapido, e sim pela ordem deles:

```
10:00  sync         traz o retardatario de D-1 para o mirror
10:15  resolucao    resolve o gateway do que acabou de chegar
10:40  materializa  vira linha em integration.financial_orders
10:50  verifica     confere contra a Shopify e emite o recibo do dia
```

Mexer no minuto de um sem olhar os outros quebra a meta mesmo com todos eles
rodando "no horario". Os minutos sao escalonados por isso, nao por estetica.

O horario da verificacao em particular e **consequencia**: `isMature` exige que
a materializacao tenha rodado depois de o dia fechar. Enquanto ela rodava as
06:00 BRT, o ultimo passe sobre D-1 era o das 23:00 BRT do proprio dia —
anterior ao fim da janela —, entao o sinal era falso por construcao e o ramo de
alerta nunca executou em producao.

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
- SHOPIFY_PRECLOSE_BATCH_SIZE: lote do passe das 10:15 BRT (default: 300)
- SHOPIFY_PRECLOSE_SINCE_DAYS: janela em dias do passe das 10:15 BRT (default: 2)

## 3) Deploy

No diretorio cloudflare/worker-sync-cron:

wrangler deploy

## 4) Validacao

- Execute manualmente no dashboard do Cloudflare (Trigger Event) ou aguarde o cron.
- Verifique se o endpoint interno retorna sucesso e cria job.
- Em caso de erro, o worker falha com status e body da resposta.
