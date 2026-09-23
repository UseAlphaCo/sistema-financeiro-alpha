# Relatório de execução das crons em produção — janela de 15 a 21/09/2026

> **Veredito:** as quatro crons rodaram **100% das execuções agendadas, sem uma única falha**, dentro
> da tolerância de atraso e com folga confortável de `maxDuration`. A execução não é o problema.
>
> **O que continua em aberto:** não existe alerta ativo. Falha e atraso só aparecem para quem abrir
> `/integracoes`. A decisão sobre qual mecanismo adotar está registrada em
> [Alerta de falha ou atraso](#alerta-de-falha-ou-atraso-decisão-registrada-implementação-em-task-separada),
> e a implementação foi deliberadamente separada desta task.

Referente à task MEU-257. Fonte de todos os números: `integration.job_runs`, lida em 21/09/2026 via
`npm run report:crons`.

## Como reproduzir

```bash
npm run report:crons              # janela padrão de 7 dias
npm run report:crons -- --days=14
```

O script ([scripts/report-cron-runs.ts](../scripts/report-cron-runs.ts)) é somente leitura e deriva a
cadência esperada de `JOB_EXPECTATIONS` ([src/features/integration/job-names.ts](../src/features/integration/job-names.ts)),
não de números repetidos nele. Se a agenda mudar em
[wrangler.jsonc](../cloudflare/worker-sync-cron/wrangler.jsonc), muda lá e o relatório acompanha —
duas listas divergentes fariam o relatório acusar "faltou execução" para um job que roda exatamente
como foi agendado.

Ele existe porque o painel de `/integracoes` responde **"como está agora"**: olha as últimas 24 h de
cada job (desde 23/09, ver [Watchdog no painel](#watchdog-no-painel-2309)). A pergunta de
acompanhamento é outra — *"como foi a semana"* —, e uma falha mais antiga que 24 h desaparece do
painel sem deixar rastro visível.

## Status das execuções

| Job | Agendadas | Realizadas | Falhas | Presas | Média | p95 | Pico | % do `maxDuration` |
|---|---|---|---|---|---|---|---|---|
| `worker-sync` | 56 | 56 (100%) | 0 | 0 | 22,6 s | 35,2 s | 54,7 s | 18% |
| `materialize-orders` | 28 | 28 (100%) | 0 | 0 | 39,8 s | 47,5 s | 47,5 s | 16% |
| `shopify-payment-resolution` | 91 | 91 (100%) | 0 | 0 | 46,5 s | 77,5 s | 149,9 s | **50%** |
| `shopify-verify` | 7 | 7 (100%) | 0 | 0 | 54,9 s | 89,9 s | 89,9 s | 30% |

**183 execuções agendadas, 183 concluídas com `status = 'ok'`.** Nenhuma linha presa em `running` —
ou seja, nenhuma invocação foi cortada no meio pelo `maxDuration` da Vercel, que é o modo de falha que
não deixaria erro registrado.

### Pontualidade e intervalos

| Job | Maior vão entre execuções | Tolerância (`staleAfterMinutes`) | Folga |
|---|---|---|---|
| `worker-sync` | 180 min | 240 min | 60 min |
| `materialize-orders` | 740 min | 900 min | 160 min |
| `shopify-payment-resolution` | 120 min | 180 min | 60 min |
| `shopify-verify` | 1440 min | 1560 min | 120 min |

Todos os vãos são exatamente o intervalo agendado, sem deslize acumulado: o Cloudflare disparou cada
cron dentro do minuto marcado, com atraso médio de 26 a 41 segundos após o minuto cheio e pior caso
de 60 segundos. As tolerâncias de `JOB_EXPECTATIONS` estão calibradas corretamente — nenhuma precisou
de ajuste, e nenhuma está tão apertada que produziria falso positivo.

### Execuções manuais

`shopify-verify` registra 10 execuções na janela, mas só 7 são do cron. As outras três
(`meu258-teste-local`, `meu258-pos-deploy`, `s0-teste-local-...`) são disparos manuais da MEU-258.

O relatório separa as duas origens pelo prefixo `cf-cron-` que o Worker põe no `x-request-id`. Sem
essa separação a contagem mente nos dois sentidos: um teste manual infla o dia e **esconde uma
execução agendada que faltou**. Foi por isso que a contagem bruta por dia mostrou "3 execuções de
verify" em 20/09, onde o esperado é 1.

## O que o pico de 150 s significa

`shopify-payment-resolution` é o único job que encosta em metade do teto. Não é sintoma: é o passe de
fechamento das 10:15 BRT funcionando como projetado — 300 pedidos × ~500 ms do portão de ritmo da
Shopify ≈ 150 s, exatamente o orçamento declarado em `SHOPIFY_PRECLOSE_BATCH_SIZE`.

A consequência prática é que **esse job é o primeiro a estourar se o lote crescer**. Um aumento de
`SHOPIFY_PRECLOSE_BATCH_SIZE` para 600 levaria o pico a ~300 s, ou seja, ao teto — e o modo de falha
não seria um erro, seria a invocação cortada no meio com a linha presa em `running`. Os outros três
jobs têm folga de 3x ou mais.

## Achado paralelo: a verificação acusou divergência em 4 dos 7 dias

Fora do escopo desta task, mas visível nos mesmos dados e relevante o bastante para registrar. O
`result.alert` de cada execução agendada de `shopify-verify`:

| Data | Alerta |
|---|---|
| 15/09 | `divergence` |
| 16/09 | `informational` |
| 17/09 | `divergence` |
| 18/09 | `divergence` |
| 19/09 | `none` |
| 20/09 | `none` |
| 21/09 | `divergence` |

`divergence` é o ramo de **dia maduro** — ou seja, não é "ainda está drenando a fila", é divergência
de valor contra a Shopify num dia que já deveria estar fechado. A rota reage sozinha (auto-alinhamento
e reconciliação), e a task MEU-258 mexeu justamente nessa área em 20/09, o que combina com os dois
`none` seguidos. **Não foi investigado aqui** — fica o registro de que o sinal existe, é recorrente e
tem quatro ocorrências na janela.

## Alerta de falha ou atraso: decisão registrada, implementação em task separada

O critério de aceite da MEU-257 pedia "alertas configurados". Isso **não foi entregue**, por decisão
explícita em 21/09/2026, depois que a opção mais barata se mostrou inexistente.

### O que foi descartado, e por quê

**Alerta nativo do Cloudflare — não existe.** Era a hipótese preferida: o Worker já lança erro quando
a rota interna responde não-ok, então bastaria ligar uma notificação. Mas a página de
[notificações disponíveis](https://developers.cloudflare.com/notifications/notification-available/)
não lista **nenhum** alerta de Workers, e a
[observabilidade de Workers](https://developers.cloudflare.com/workers/observability/) oferece logs,
métricas, tracing e export — não alerting. Não há o que configurar.

**Watchdog interno rodando como cron — cego para o pior cenário.** Uma rota que lê `job_runs`,
compara com `JOB_EXPECTATIONS` e dispara um webhook resolveria falha, atraso e execução presa, com
diagnóstico rico. Mas ela roda *na mesma infraestrutura que está sendo vigiada*: se os cron triggers
do Cloudflare pararem de disparar, o watchdog também não roda, e o silêncio é indistinguível de
"está tudo bem". Esse cenário não é hipotético — há relatos de cron triggers do Cloudflare parando
de disparar em agosto e setembro de 2026.

### O que foi decidido

**Heartbeat externo (*dead man's switch*)** é a recomendação registrada: cada job pinga uma URL ao
concluir com sucesso, e um serviço externo em plano gratuito alerta por e-mail quando o ping não
chega no prazo. É o único mecanismo que detecta o agendador morrer, porque o observador está fora
dele. Custo de implementação: um `fetch` no caminho de sucesso e uma variável de ambiente por job,
sem dependência npm nova.

A implementação foi separada desta task por tamanho — MEU-257 vale 1 ponto e a medição já a consome
inteira.

## Por que isso não podia continuar sem alerta

O argumento não é teórico e já está registrado no código, em
[IntegrationsHealthPanel.tsx](../src/app/(app)/_components/IntegrationsHealthPanel.tsx): em
**09/09/2026 o `shopify-verify` falhou e ficou 12 dias sem ninguém notar**. O painel estava correto e
mostrava a falha — ninguém abriu a tela. Uma semana de 100% de sucesso, como a que este relatório
mede, é exatamente a condição em que se para de olhar o painel.

## Watchdog no painel (23/09)

A MEU-307 tirou a decisão de "este job está errado" de dentro do JSX do painel e a pôs numa função
pura, `assessPipelineHealth` em [job-names.ts](../src/features/integration/job-names.ts). O painel
ganhou um bloco no topo com o veredito consolidado. Por job:

| Veredito | Tom | Quando |
|---|---|---|
| `falhou` | crítico | a última execução agendada terminou em erro |
| `travado` | crítico | a última está `running` há mais de 2× o `maxDuration` da rota: a Vercel já a matou |
| `atrasado` | crítico | a última começou há mais que `staleAfterMinutes` |
| `poucas_execucoes` | atenção | menos execuções que `expectedPerDay` em 24 h + 15 min |
| `falhas_recentes` | atenção | a última foi bem, mas outra das últimas 24 h falhou ou morreu `running` |

Três decisões que não são detalhe:

- **Só execução agendada conta**, pelo mesmo prefixo `cf-cron-` deste relatório. Contar disparo
  manual esconderia o pior caso: o agendador parado e alguém rodando o job à mão para testar.
- **`maxDurationSeconds` é cópia do `maxDuration` da rota**, com teste que falha se as duas
  divergirem. É o que separa `running` legítimo de travado.
- **`pipelineAlertText` devolve texto só para os casos críticos.** Nenhum canal consome isso ainda: a
  função existe para que ligar o heartbeat externo ou um webhook seja uma chamada, não um refactor.

A ressalva da seção anterior continua de pé: o watchdog fala pelo painel, então não detecta a própria
morte nem o cenário em que ninguém abre a tela. O heartbeat externo segue sendo a peça que falta.

## Conclusão

- **Execução:** saudável, sem ressalva. 183/183 agendadas, zero falha, zero atraso, folga de tempo
  confortável em três dos quatro jobs.
- **Medição:** deixou de ser SQL ad-hoc — `npm run report:crons` repete o relatório a qualquer
  momento, derivando a expectativa da mesma fonte que o painel usa.
- **Vigilância:** o painel passou a dar veredito (falhou, travado, atrasado, execuções faltando),
  mas continua passiva: depende de alguém abrir a tela. O alerta externo segue em task separada.
- **A vigiar:** `shopify-payment-resolution` em 50% do `maxDuration`, e a divergência recorrente do
  `shopify-verify`.
