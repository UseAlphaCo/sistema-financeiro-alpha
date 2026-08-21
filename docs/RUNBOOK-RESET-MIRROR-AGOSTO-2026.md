# Runbook — reset do mirror para a janela de agosto/2026

Zera `mirror.raw_payloads` e `integration.sync_queue` e recarrega agosto/2026 a partir do backup
local do OMS. Preserva `integration.shopify_order_payment_resolution`.

**Estado esperado no fim:** 520.939 linhas no mirror, nada anterior a 01/08/2026, fila de sync vazia,
cursores reposicionados, e o piso de data (`SYNC_MIRROR_FLOOR_AT`, commit `cd0ee36`) impedindo que a
auditoria rebaixe abril–julho de volta.

**Executado por um operador humano**, e nao por agente: o volume do backup fica em
`/Volumes/externo-ugreen`, e o TCC do macOS nega acesso ao shell do agente (o Terminal do usuario tem
a permissao). Toda medicao do lado do banco pode ser conferida por qualquer um dos dois.

## Por que truncar em vez de completar

O mirror tinha 810.637 linhas: 604.418 de 26/04 a 31/07 e 206.219 de agosto, e estava parado em
18/08. O OMS tinha 454.623 linhas so ate 18/08 — ou seja, agosto estava **pela metade**, e e agosto
que o sistema precisa exibir. Completar agosto pelo sync significa rebaixar ~315 mil linhas do OMS
pela rede, que e exatamente o consumo que derrubou o Supabase em 11/08. O backup entrega as mesmas
linhas de um arquivo local, sem tocar o OMS.

Abril–julho sai por decisao explicita: e volume que ninguem consulta hoje e que faz cada volta de
auditoria custar 604 mil anti-joins. A perda **nao e irreversivel** — o OMS continua com tudo, e
`audit` + piso reconstroem qualquer janela sem CSV nenhum.

## Ambiente

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
  echo "ERRO: rode este bloco de dentro do repositorio"
else
  cd "$ROOT"
  set -a && . ./.env && set +a
  export PATH="$(brew --prefix libpq)/bin:$PATH"
  export CORE_URL="$CORE_DB_URL"
  export OMS_URL="$OMS_DB_URL"
  [ -n "$CORE_URL" ] && echo "raiz: $PWD | CORE_URL definida (${#CORE_URL} caracteres)" \
                     || echo "ERRO: CORE_DB_URL ausente no .env"
  psql --version
fi
```

```bash
export BKP="$(ls -d /Volumes/externo-ugreen/backup-*raw_payloads* 2>/dev/null | tail -1)"
echo "backup: $BKP" && ls -la "$BKP"
```

Convencoes que nao sao estilo, sao correcao:

- **`-v ON_ERROR_STOP=1` em todo `psql`.** Com varios `-c`, um `SET` que falhe nao aborta a invocacao:
  o `\copy` seguinte rodaria com `statement_timeout` de 30 s e cairia no meio.
- **`-q` sempre que houver `\copy` no mesmo comando.** Sem ele o psql imprime `SET` na saida, e num
  `\copy TO STDOUT` isso entra no arquivo.
- **Fuso no literal (`-03`), nunca na sessao.** O Supavisor descarta `PGOPTIONS`/`PGTZ` do startup
  packet; so `SET` explicito vale, e o literal dispensa a discussao.
- **Sem comentario `#` no fim de linha.** O zsh desta maquina nao tem `interactive_comments`.
- `set -o pipefail` ligado nos blocos com pipe, senao um `gzcat` que morre passa por sucesso.

## Passo 1 — validar o backup INTEIRO antes de truncar

Esta e a regra que nao se negocia: nada e apagado antes de o arquivo estar provado.

```bash
( cd "$BKP" && shasum -a 256 -c SHA256SUMS.txt )
for f in "$BKP"/02-raw_payloads-*.csv.gz; do
  gzip -t "$f" && echo "integro   $(basename "$f")" || echo "CORROMPIDO $(basename "$f")"
done
```

Contagem por regex de uuid, e **nao** `wc -l`: `error_message` e texto livre e um `\n` cru dentro de
um campo aspado inflaria a contagem de linhas sem inflar a de registros.

```bash
for f in "$BKP"/02-raw_payloads-*.csv.gz; do
  printf '%s %s\n' "$(basename "$f")" "$(gzcat "$f" | grep -Ec '^[0-9a-f]{8}-[0-9a-f]{4}-')"
done
```

Esperado: `2026-08-01` 170867, `2026-08-08` 188171, `2026-08-15` 161901, `2026-08-22` 0,
`2026-08-29` 0. Total 520.939.

Header de toda fatia tem de comecar em `id,source,external_order_id,`; header `SET` significa que o
`-q` foi perdido na extracao e o arquivo esta contaminado.

```bash
for f in "$BKP"/02-raw_payloads-*.csv.gz; do gzcat "$f" | head -1 | cut -c1-40; done
```

**Unicidade de `id` no conjunto todo.** E isto que autoriza `\copy` direto, sem staging table e sem
`ON CONFLICT`:

```bash
gzcat "$BKP"/02-raw_payloads-*.csv.gz | grep -E '^[0-9a-f]{8}-[0-9a-f]{4}-' | cut -d, -f1 \
  | sort | tee /tmp/ids-agosto.txt | uniq -d | head
wc -l < /tmp/ids-agosto.txt
sort -u /tmp/ids-agosto.txt | wc -l
```

`uniq -d` vazio e as duas contagens iguais a 520939. Se houver duplicata, **pare**: o caminho passa a
ser staging table com `ON CONFLICT DO NOTHING`, e o motivo da duplicata precisa ser entendido antes.

## Passo 2 — registrar o estado atual

O `indexdef` do mirror nao esta versionado em nenhum arquivo do repo. Capturar antes e a unica forma
de recriar se algo der errado.

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout = 0" \
  -c "SELECT count(*) AS mirror FROM mirror.raw_payloads" \
  -c "SELECT count(*) AS fila, count(*) FILTER (WHERE operation <> 'FETCH') AS nao_fetch FROM integration.sync_queue" \
  -c "SELECT count(*) AS resolucoes FROM integration.shopify_order_payment_resolution" \
  -c "SELECT pg_size_pretty(pg_total_relation_size('mirror.raw_payloads')) AS tamanho" \
  -c "SELECT stream, pass, next_block, lap_end_block, lap_number FROM integration.sync_scan_cursor ORDER BY pass" \
  -c "SELECT * FROM integration.sync_watermark"

psql -q "$CORE_URL" -Atc \
  "SELECT indexdef FROM pg_indexes WHERE schemaname='mirror' AND tablename='raw_payloads'" \
  | tee "$BKP/03-indices-mirror.sql"
```

`nao_fetch` deve ser 0. Se nao for, o `TRUNCATE` do passo 5 vira
`DELETE FROM integration.sync_queue WHERE operation = 'FETCH'`.

## Passo 3 — smoke test da carga, em tabela temporaria

Prova pipe + `SET` + `\copy` + tipos + header numa unica invocacao, antes de qualquer destruicao.
`PSTDIN` e a grafia documentada para "a stdin do processo psql"; com `-c`, `STDIN` e ambiguo por
definicao.

```bash
set -o pipefail
gzcat "$BKP/02-raw_payloads-2026-08-01.csv.gz" | head -1001 | psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout = 0" \
  -c "CREATE TEMP TABLE smoke (LIKE mirror.raw_payloads)" \
  -c "\copy smoke (id,source,external_order_id,event_type,payload_json,headers_json,received_at,processed_at,processing_status,error_message) FROM PSTDIN WITH (FORMAT csv, HEADER match)" \
  -c "SELECT count(*) AS linhas, min(received_at) AS min, max(received_at) AS max FROM smoke"
```

Esperado `COPY 1000` e a janela dentro de 01/08. `HEADER match` (PG >= 16; o CORE e 17.6) valida os
**nomes** do header contra a lista de colunas, na ordem — transforma um erro de ordem de coluna de
silencioso em ruidoso. A temp table morre com a sessao; nada a limpar.

## Passo 4 — tirar o default de `mirror_updated_at`

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE mirror.raw_payloads ALTER COLUMN mirror_updated_at DROP DEFAULT" \
  -c "SELECT column_name, column_default FROM information_schema.columns WHERE table_schema='mirror' AND table_name='raw_payloads' AND column_name IN ('synced_at','mirror_updated_at')"
```

Mudanca de catalogo, instantanea, sem reescrever tupla. Existe para evitar dois danos silenciosos que
`DEFAULT now()` causaria numa carga em bloco:

1. `shopify-payment-resolution-repository.ts:107` filtra por `rp.mirror_updated_at > spr.resolved_at`.
   Com todas as 520.939 linhas nascendo em `now()`, elas seriam mais novas que todos os 46.191
   `resolved_at`, o resolvedor consideraria **tudo** obsoleto e queimaria a API da Shopify — anulando
   a decisao de preservar a tabela.
2. `read-model.ts:131-133` desempata o dedup por `mirror_updated_at ?? received_at` com `>`
   **estrito**, e `listMirrorTransactions` nao tem `ORDER BY`. Com todas as linhas empatadas no mesmo
   instante, o `>` nunca e verdadeiro e vence a primeira em ordem de heap — o oposto do que o
   comentario do proprio codigo promete.

Com `NULL`, o desempate cai em `received_at`, que e a recencia real do evento. O default volta no
passo 10.

## Passo 5 — zerar a fila de sync (antes do mirror)

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '10s'" \
  -c "TRUNCATE TABLE integration.sync_queue" \
  -c "SELECT count(*) AS fila FROM integration.sync_queue"
```

Ordem importa, e por correcao e nao por economia: as ~490 mil entradas foram descobertas antes do
piso existir e sao quase todas de abril–julho. Drena-las **depois** da carga faria a reparacao
reinserir linhas pre-agosto no mirror recem-zerado. O piso na drenagem (commit `cd0ee36`) ja barra a
escrita, mas cada lote barrado ainda paga a leitura de 2.000 payloads TOASTeados no OMS — medido em
~4 s por lote. Zerar a fila e o que evita esse desperdicio.

## Passo 6 — truncar o mirror

```bash
psql -q "$CORE_URL" -Atc \
  "SELECT pid, state, left(query,60) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"

psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "SET lock_timeout = '10s'" \
  -c "TRUNCATE TABLE mirror.raw_payloads" \
  -c "SELECT count(*) AS mirror FROM mirror.raw_payloads"
```

Sem `CASCADE` e sem lista de tabelas: `CASCADE` seguiria FKs para tabelas que nao estao neste plano.
O `lock_timeout` existe porque `TRUNCATE` pede ACCESS EXCLUSIVE — sem timeout, ele espera e enfileira
todo leitor atras de si.

## Passo 7 — carregar as 3 fatias

Uma invocacao por fatia, `\copy` direto para as 10 colunas nomeadas (`synced_at` cai no default,
`mirror_updated_at` fica `NULL`). Sem staging e sem UPSERT: a unicidade esta provada no passo 1, e
assim um `duplicate key` passa a ser o sinal **desejado** de fatia carregada duas vezes.

```bash
set -o pipefail
caffeinate -i bash -c '
for arq in "$BKP"/02-raw_payloads-2026-08-01.csv.gz \
           "$BKP"/02-raw_payloads-2026-08-08.csv.gz \
           "$BKP"/02-raw_payloads-2026-08-15.csv.gz; do
  echo "--- $(basename "$arq")"
  t0=$SECONDS
  gzcat "$arq" | psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
    -c "SET statement_timeout = 0" \
    -c "\copy mirror.raw_payloads (id,source,external_order_id,event_type,payload_json,headers_json,received_at,processed_at,processing_status,error_message) FROM PSTDIN WITH (FORMAT csv, HEADER match)"
  echo "    saiu com $? em $((SECONDS-t0))s"
done
'
```

Conferir `COPY 170867`, `COPY 188171` e `COPY 161901` na hora de cada uma.

**Tempo: 1 a 3 horas.** Sao ~3,5 GB de texto subindo por uplink domestico; a extracao levou 62 min na
descida. Vazao instavel e normal (a extracao variou de 100 a 340 linhas/s na mesma execucao), entao
trate qualquer estimativa como ordem de grandeza.

**Indices ficam.** O gargalo e uplink e TOAST (~3,5 GB no fio) contra ~88 MB de indice a construir; o
`TRUNCATE` ja entregou indices vazios, entao nao ha bloat a evitar; e dropar cria um estado duravel em
que o mirror roda sem indice se a sessao morrer — e sabemos que a sessao morre. Se a vazao da primeira
fatia mostrar CPU de servidor e nao banda, o fallback e dropar os 6 secundarios (nunca a PK) e
recriar a partir de `$BKP/03-indices-mirror.sql`.

## Passo 8 — se cair no meio

Cada `\copy` e transacao implicita propria: uma queda de SSL faz rollback da fatia inteira, entao
repetir e seguro. Mas existe a janela em que o servidor comita e a conexao cai antes do cliente saber
— por isso o critério de retomada e **o estado do banco**, nunca o exit status:

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 -Atc \
  "SELECT to_char(date_trunc('week', COALESCE(received_at,processed_at) AT TIME ZONE 'America/Sao_Paulo'),'YYYY-MM-DD') AS semana, count(*)
   FROM mirror.raw_payloads GROUP BY 1 ORDER BY 1"
```

Para a faixa da fatia: `0` → carregar; `== esperado` → pular; **qualquer outro valor** → parar e
investigar antes de escrever mais nada.

Se a mesma fatia cair duas vezes, derive o host direto (o `DIRECT_URL` do `.env` **tambem** e pooler):

```bash
export CORE_DIRECT_URL="$(npx tsx -e "
import {config} from 'dotenv'; config({path:'.env'});
const u=new URL(process.env.CORE_DB_URL);
const ref=decodeURIComponent(u.username).split('.')[1];
console.log('postgresql://postgres:'+u.password+'@db.'+ref+'.supabase.co:5432/postgres');
" 2>/dev/null | tail -1)"
```

So depois disso vale subdividir com staging table persistente e `ON CONFLICT DO NOTHING` — o unico
cenario em que staging se paga, e por idempotencia de sublote, nao por conflito de chave.

## Passo 9 — verificar

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout = 0" \
  -c "SELECT count(*) AS total,
             count(*) FILTER (WHERE COALESCE(received_at,processed_at) IS NULL) AS sem_data,
             count(*) FILTER (WHERE COALESCE(received_at,processed_at) < '2026-08-01 00:00:00-03'::timestamptz) AS antes_do_piso,
             min(COALESCE(received_at,processed_at)) AS minimo,
             max(COALESCE(received_at,processed_at)) AS maximo
      FROM mirror.raw_payloads" \
  -c "SELECT source, count(*) FROM mirror.raw_payloads GROUP BY 1 ORDER BY 2 DESC" \
  -c "SELECT to_char(COALESCE(received_at,processed_at) AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia, count(*)
      FROM mirror.raw_payloads GROUP BY 1 ORDER BY 1"
```

Esperado: `total` 520939, `sem_data` 0, `antes_do_piso` 0, minimo em 01/08, maximo ~20/08 17:33, e
**20 dias sem buraco**.

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout = 0" \
  -c "VACUUM (ANALYZE) mirror.raw_payloads" \
  -c "SELECT indexrelname, idx_scan FROM pg_stat_user_indexes WHERE schemaname='mirror'" \
  -c "SELECT count(*) AS indices_invalidos FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE c.relname='raw_payloads' AND NOT i.indisvalid" \
  -c "SELECT count(*) AS resolucoes FROM integration.shopify_order_payment_resolution"
```

O `VACUUM (ANALYZE)` nao e higiene opcional: depois de `TRUNCATE` + `COPY` as estatisticas estao
vazias e o planner acha que a tabela tem zero linhas — todo plano do read model sai errado. `indices
_invalidos` = 0 e `resolucoes` = 46191.

Comparacao contra o OMS, com o **mesmo** literal de fuso e o mesmo teto do dump. OMS >= mirror e
esperado (linhas que chegaram depois do dump); mirror > OMS em qualquer dia e defeito.

```bash
psql -q "$OMS_URL" -v ON_ERROR_STOP=1 \
  -c "SET statement_timeout = 0" \
  -c "SET default_transaction_read_only = on" \
  -Atc "SELECT to_char(COALESCE(received_at,processed_at) AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD'), count(*)
        FROM public.raw_payloads
        WHERE COALESCE(received_at,processed_at) >= '2026-08-01 00:00:00-03'::timestamptz
          AND COALESCE(received_at,processed_at) <  '2026-08-20 17:33:00-03'::timestamptz
        GROUP BY 1 ORDER BY 1"
```

Uma varredura so (a tabela nao tem indice em `received_at` — e a causa raiz de todo este desenho), ~80
s, read-only. **Nao rode isto junto com outra carga no OMS.**

## Passo 10 — restaurar o default e reposicionar os cursores

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER TABLE mirror.raw_payloads ALTER COLUMN mirror_updated_at SET DEFAULT now()" \
  -c "INSERT INTO integration.sync_cycle_log (stream, cycle_id, trigger_source, outcome, started_at, finished_at, rows_repaired)
      VALUES ('oms_raw_payloads', gen_random_uuid(), 'manual-fase-a', 'ok', now(), now(), 520939)"
```

Cursores, **depois** de a carga estar verificada:

```bash
psql -q "$CORE_URL" -v ON_ERROR_STOP=1 \
  -c "UPDATE integration.sync_scan_cursor
         SET next_block = 0, lap_start_block = 0, lap_end_block = NULL, blocks_covered = 0, lap_number = 0
       WHERE stream = 'oms_raw_payloads' AND pass = 'audit'" \
  -c "UPDATE integration.sync_scan_cursor
         SET next_block = GREATEST(next_block - 12000, 0)
       WHERE stream = 'oms_raw_payloads' AND pass = 'tail'" \
  -c "DELETE FROM integration.sync_watermark
       WHERE stream = 'oms_raw_payloads'
         AND (SELECT count(*) FROM mirror.raw_payloads) > 0" \
  -c "SELECT pass, next_block, lap_end_block, lap_number FROM integration.sync_scan_cursor WHERE stream='oms_raw_payloads' ORDER BY pass"
```

Cada um por um motivo distinto:

- **`audit` do zero.** A volta parcial corria contra um mirror que nao existe mais, e `lap_number` nao
  pode acumular por cima disso — a regra das duas voltas passaria a contar uma volta que auditou outra
  tabela. E a mesma logica de `detectHeapRewrite`, so que aqui quem mudou foi o mirror, e o codigo nao
  detecta esse lado.
- **`tail` recuado ~12.000 blocos.** O CSV para em 20/08 17:33 e o heap seguiu crescendo;
  `TAIL_LOOKBACK_BLOCKS = 500` cobre so ~5.400 linhas, insuficiente para alcancar a cauda descoberta.
- **Marca d'agua apagada, com guarda.** `findMirrorMaxSortAt` se auto-inicializa do topo do mirror e
  loga `derivedFrom: "mirror_max"` — melhor que um timestamp digitado a mao. A guarda
  `count(*) > 0` importa: com o mirror vazio o fallback seria o piso (nao mais a epoca, desde
  `cd0ee36`), mas apagar a marca sem dado no mirror nao tem sentido nenhum.

## Passo 11 — fechar a primeira volta e conferir o piso

```bash
for i in $(seq 1 15); do npx tsx src/workers/sync/run-once.ts; done
```

Nos logs, `rowsBelowFloor` alto com `rowsMissing` proximo de zero nas faixas antigas e a assinatura de
uma volta sadia depois do truncate. Ao fim, reconfirmar:

```bash
psql -q "$CORE_URL" -Atc \
  "SELECT count(*) FILTER (WHERE COALESCE(received_at,processed_at) < '2026-08-01 00:00:00-03'::timestamptz) FROM mirror.raw_payloads"
```

Tem de continuar `0`. Se der `> 0`, o piso nao esta no caminho que rodou — pare e investigue antes de
seguir para a materializacao.

## Rollback

Abril–julho e perda deliberada; o OMS continua com tudo. A janela de agosto **nao** e irreversivel: se
o CSV se revelar insuficiente, `audit` + piso reconstroem a janela sem CSV nenhum, so mais devagar. O
CSV e otimizacao de velocidade sobre a auditoria, nao a unica fonte — e e isso que limita o risco do
`TRUNCATE`.
