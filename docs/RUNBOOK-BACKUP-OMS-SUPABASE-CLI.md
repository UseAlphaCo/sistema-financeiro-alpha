# Runbook — backup logico de `public.raw_payloads` do OMS, de agosto/2026 em diante

> **Status: EXECUTADO E VERIFICADO em 2026-08-20.** Nao e mais um procedimento proposto — rodou
> inteiro, em fatias semanais, e o resultado foi conferido contra o banco.
>
> | | |
> |---|---|
> | destino | `/Volumes/externo-ugreen/backup-oms-2026-08-20260820-1551` |
> | conteudo | 5 arquivos `.csv.gz` (3 com dado, 2 so header) + `SHA256SUMS.txt` |
> | linhas | **520.939** |
> | tamanho | **438 MB** |
> | duracao | 62 min |
> | cobertura | 01/08 ate ~17:33 de 20/08 (ver a ressalva da cauda no fim) |
> | conferencia | `gzip -t` OK nos 5; contagem das duas semanas fechadas bate exato com o banco: `170867|188171` |
>
> Execucao e manual, comando a comando. Para repetir, o caminho e o **fatiamento** (Passo 4 →
> "Fatiamento"), nao o `\copy` unico.

Copia de seguranca logica de **uma unica tabela** — `public.raw_payloads` — **de 2026-08-01 em
diante, sem limite superior**, independente dos backups gerenciados da Supabase. O OMS e banco de
producao de outro time e e **read-only** para esta aplicacao: todo comando aqui apenas le.

## Escopo

| item | valor |
|---|---|
| tabela | `public.raw_payloads` — e so ela |
| filtro | `COALESCE(received_at, processed_at) >= '2026-08-01 00:00:00-03'::timestamptz` |
| limite superior | **nenhum** — pega tudo de agosto para frente, ate o instante do dump |
| linhas na janela | **519.879** em 2026-08-20 18:57 UTC (cresce a cada execucao) |
| linha mais antiga | `2026-08-01 00:00:25-03` — confirma que a borda esta no lugar |
| tamanho estimado | ~3,5 GB de CSV, ~0,4-0,6 GB apos `gzip` |

`received_at` e `processed_at` sao `timestamptz`; o `COALESCE` cobre as linhas que chegaram sem
`received_at`. Nenhuma outra tabela entra — nem `orders`, nem `order_events`, nem os schemas de
`integration`.

### O fuso vai no literal, nao na sessao

**O pooler Supavisor ignora `PGTZ` e `PGOPTIONS`** — medido em 2026-08-20: com as duas exportadas, a
sessao voltou `TimeZone=UTC` e `default_transaction_read_only=off`. Confiar em fuso de sessao faz a
borda do mes escorregar 3 horas em silencio, e isso e mensuravel: o filtro `>= '2026-08-01'`
interpretado em UTC traz **523.768** linhas, contra **519.879** com o offset explicito — 3.889 linhas
de 31 de julho entrando como se fossem de agosto.

Por isso o filtro usa literal com offset: `'2026-08-01 00:00:00-03'::timestamptz`. Independe de
sessao, servidor e pooler. O Brasil nao tem mais horario de verao, entao `-03` e estavel.

## Levantamento feito em 2026-08-19

| fato | valor |
|---|---|
| tamanho do OMS | **13 GB**, dos quais `public.raw_payloads` e **5.989 MB** — a maior tabela |
| papel de conexao | `postgres` (nao superuser, mas **le as 45 tabelas** dos 6 schemas) |
| conexao do `.env` | pooler Supavisor, porta 5432 (IPv4) |
| conexao direta | `db.<ref>.supabase.co:5432` — **so IPv6**, alcancavel da maquina de trabalho |
| versao do servidor | PostgreSQL 17.6 |
| disco externo | HFS+ journaled, 441 GB livres, `Volume Read-Only: No` |

### Tres restricoes que moldam o procedimento

1. **A CLI da Supabase nao serve para este recorte, em nenhuma das duas dimensoes.**
   `supabase db dump` recorta por schema — tem `--schema` e `--exclude schema.tabela`, mas **nao tem
   `--table` para incluir uma tabela so, nem `--where`** (conferido em `supabase db dump --help`, CLI
   de 2026-08-20). Ou seja: pela CLI nao da para pegar so `raw_payloads`, nem so agosto. O caminho e
   `psql` para os dados e `pg_dump --table` para o DDL — os dois vem do mesmo `libpq` (Passo 2).
   Se em algum momento o schema inteiro for desejavel como contexto de restauracao, a CLI ainda faz
   isso em segundos: `supabase db dump --db-url "$OMS_URL" -s public,integration -f 02-schema.sql`.
2. **Sem indice util para o filtro.** O DDL da tabela mostra dois indices —
   `(source, external_order_id)` e um parcial `(source, error_message, received_at DESC, id DESC)`
   restrito a `processing_status = 'failed'` — nenhum atende `received_at` no caso geral. O recorte
   custa um **seq scan dos 5.989 MB**, mesmo trazendo ~500 mil linhas.
3. **`gzip` no pipe, sem arquivo intermediario.** ~3,5 GB de CSV cabem no externo, mas nao no disco
   interno (14 GB livres). Comprimindo no pipe, o que toca o disco ja e o arquivo final.

## Passo 0 — liberar o disco externo no macOS

O volume nao e read-only e pertence ao usuario (`drwxrwxr-x sendylago:staff`), mas o **TCC do
macOS** bloqueia processos sem permissao para volumes removiveis — de dentro de um terminal sem
permissao ate `ls` retorna `Operation not permitted`.

```bash
ls /Volumes/externo-ugreen && touch /Volumes/externo-ugreen/.teste && rm /Volumes/externo-ugreen/.teste && echo "acesso OK"
```

Se falhar: **Ajustes do Sistema → Privacidade e Seguranca → Arquivos e Pastas** (ou **Acesso Total
ao Disco**) e libere o Terminal. Nao siga sem `acesso OK`.

## Passo 1 — variaveis de ambiente

```bash
cd /Users/sendylago/Alpha/dev/sistema-financeiro
set -a && . ./.env && set +a
export OMS_URL="$OMS_DB_URL"
export BKP="/Volumes/externo-ugreen/backup-raw_payloads-$(date +%Y%m%d-%H%M)"
export DESDE="2026-08-01 00:00:00-03"
export FILTRO="COALESCE(received_at, processed_at) >= '$DESDE'::timestamptz"
mkdir -p "$BKP"
```

Nao exporte `PGTZ` nem `PGOPTIONS`: o pooler os descarta. O offset mora dentro de `DESDE` e viaja
junto com a consulta.

Confirmacao sem expor a credencial:

```bash
[ -n "$OMS_URL" ] && echo "OMS_URL definida (${#OMS_URL} caracteres) | desde: $DESDE | destino: $BKP"
```

## Passo 2 — `psql` disponivel

O `psql` nao vem no macOS. Ele ja esta instalado nesta maquina via `libpq`, fora do `PATH`:

```bash
brew install libpq   # no-op se ja instalado
export PATH="/opt/homebrew/opt/libpq/bin:$PATH"
psql --version       # 18.4 nesta maquina
```

Cliente 18.x contra servidor 17.6 esta correto aqui: `\copy` e do lado do cliente, roda
`COPY ... TO STDOUT` no servidor e escreve CSV local — nao ha formato de dump envolvido, entao nao
existe requisito de versao igual. Para o `pg_dump --schema-only` do Passo 3, cliente mais novo que
servidor tambem e suportado (testado: `pg_dump` 18.6 leu o servidor 17.6 sem erro).

Smoke test que valida credencial, rede, recorte e read-only de uma vez:

```bash
psql -q "$OMS_URL" \
  -c "SET statement_timeout = 0" \
  -c "SET default_transaction_read_only = on" \
  -Atc "SELECT count(*), min(COALESCE(received_at, processed_at)) FROM public.raw_payloads WHERE $FILTRO"
```

Deve responder algo proximo de `519879|2026-08-01 03:00:25.163+00` (o `+00` e so a exibicao em UTC —
o instante e `00:00:25-03`). Se falhar por conexao, va ao fallback antes de gastar horas.

### Os dois `SET` sao obrigatorios, e so funcionam por `-c`

**`SET statement_timeout = 0`.** O papel `postgres` vem com **`statement_timeout` de 2 minutos**, e
o `\copy` do Passo 4 leva dezenas de minutos: sem desarmar, o dump morre com
`ERROR: canceling statement due to statement timeout` — **ja aconteceu em execucao real**. Vale para
qualquer consulta que varra a tabela, inclusive a contagem de verificacao do Passo 5.

**`SET default_transaction_read_only = on`.** Garantia, no proprio servidor, de que nada daqui
escreve no OMS: com ela na sessao, um `CREATE TABLE` de teste foi recusado com
`cannot execute CREATE TABLE in a read-only transaction`.

Os dois **tem de vir por `-c`, antes do comando principal e na mesma invocacao do `psql`** — e o que
os coloca na mesma sessao. Nao tente pelo ambiente: **o pooler descarta `PGOPTIONS`** (medido: sessao
voltou `off` com `PGOPTIONS` exportada). Conferido que a dupla pega: `0 | on`.

## Passo 3 — DDL da tabela (KB, e o smoke test barato)

Estrutura nao tem data: o DDL sai integral, mas restrito a esta tabela.

```bash
pg_dump "$OMS_URL" --schema-only --table=public.raw_payloads \
  --no-owner --no-privileges -f "$BKP/01-schema-raw_payloads.sql"

grep -c "CREATE TABLE" "$BKP/01-schema-raw_payloads.sql"   # esperado: 1
ls -lh "$BKP"
```

Saindo o arquivo, estao provados de uma vez conexao, permissao do disco externo e o `pg_dump` — em
segundos, nao em horas.

**Duas coisas que este DDL carrega e que importam na restauracao:**

- `CREATE TRIGGER trg_raw_payloads_sync ... EXECUTE FUNCTION integration.capture_raw_payloads_changes()`
  (ja `DISABLE`d no OMS). Restaurar em um banco que nao tenha essa funcao **falha** nessa linha.
  Remova o trigger do arquivo, ou crie a funcao antes.
- `ALTER TABLE public.raw_payloads ENABLE ROW LEVEL SECURITY`. Sem politicas restauradas junto, a
  tabela restaurada fica invisivel para papeis que nao sejam owner nem `BYPASSRLS`.

## Passo 4 — os dados

Uma unica consulta, comprimida no pipe. Registre o instante de inicio: ele e a referencia da
verificacao, porque a tabela continua recebendo linhas durante o dump.

```bash
export T0="$(date -u +'%Y-%m-%d %H:%M:%S+00')"; echo "inicio: $T0"

set -o pipefail
time caffeinate -i psql -q "$OMS_URL" \
  -c "SET statement_timeout = 0" \
  -c "SET default_transaction_read_only = on" \
  -c "\copy (SELECT * FROM public.raw_payloads WHERE $FILTRO) TO STDOUT CSV HEADER" \
  | gzip -6 > "$BKP/02-raw_payloads.csv.gz"
echo "status: $?"
```

> **`SET statement_timeout = 0` nao e opcional.** Sem ele o dump morre em 2 minutos com
> `ERROR: canceling statement due to statement timeout` — o limite do papel `postgres`. Ver Passo 2.

> **O `-q` e obrigatorio, nao cosmetico.** Sem ele, os `SET` imprimem linhas `SET` no stdout, que
> entram no `.csv.gz` **antes do header** e corrompem o arquivo — observado no teste de 2026-08-20.
> `caffeinate -i` impede a maquina de dormir no meio.

**Nao rode este `\copy` unico — ele nao termina.** Em duas tentativas reais de 2026-08-20 o mes
inteiro de uma vez falhou: a primeira no `statement_timeout`, a segunda com
`COPY data transfer failed: SSL connection has been closed unexpectedly`. O comando fica aqui como
referencia da forma (os dois `SET`, o `-q`, o pipe); **a execucao de verdade e o fatiamento semanal**
do fallback, que rodou inteiro sem uma queda: 520.939 linhas, ~440 MB, 62 min.

A vazao e **instavel**: entre 100 e 340 linhas/s em fatias de volume parecido, na mesma execucao. O
tempo escala com linhas, nao com a varredura — uma fatia de 4 h levou 49 s, uma de 24 h levou 263 s,
entao o seq scan sozinho custa ~40 s.

Acompanhe de outro terminal:

```bash
watch -n 30 'ls -lh '"$BKP"'/02-raw_payloads*.csv.gz'
```

> **Nao rode junto com o dreno de recuperacao do mirror.** Os dois leem `raw_payloads` inteira, que
> e producao de outro time, e uma carga anterior ja causou `statement timeout` la.

## Passo 5 — verificacao

O modo de falha classico e o CSV truncado que *parece* pronto: `gzip` fecha um stream cortado sem
reclamar. A prova e contar as linhas do arquivo contra o banco, com o mesmo filtro.

```bash
gzip -t "$BKP/02-raw_payloads.csv.gz" && echo "gzip OK"
[ "$(gzcat "$BKP/02-raw_payloads.csv.gz" | head -1)" = "SET" ] && echo "CONTAMINADO: refazer com -q"
echo "arquivo: $(( $(gzcat "$BKP/02-raw_payloads.csv.gz" | wc -l) - 1 )) linhas de dados"
```

Do lado do banco, com **o mesmo filtro e o teto no instante de inicio** — sem o teto a comparacao
seria sempre desigual, porque linhas novas entraram durante o dump:

```bash
psql -q "$OMS_URL" -c "SET statement_timeout = 0" -c "SET default_transaction_read_only = on" -Atc "
SELECT count(*) FROM public.raw_payloads
WHERE $FILTRO AND COALESCE(received_at, processed_at) < '$T0'::timestamptz"
```

A relacao esperada e **arquivo ≥ banco-com-teto**, nunca o contrario: o `\copy` nao tem limite
superior e comeca depois de `T0`, entao ele legitimamente carrega o que chegou durante o dump. Medido
em 2026-08-20 numa janela curta: 2.806 linhas no arquivo contra 2.805 no banco com teto — a linha
extra chegou nos segundos entre um e outro. Em uma execucao de dezenas de minutos, espere uma
diferenca proporcional ao trafego do periodo.

**Arquivo com menos linhas que o banco-com-teto e truncamento** — o `\copy` nao pode ter perdido
linhas anteriores a `T0`. Refaca.

Checksum e tamanho final, para auditoria:

```bash
( cd "$BKP" && shasum -a 256 *.sql *.csv.gz > SHA256SUMS.txt && cat SHA256SUMS.txt )
du -sh "$BKP"; ls -lh "$BKP"
```

## Fallback — se cortar no meio

Distinga os dois cortes, porque a correcao e diferente:

- **`ERROR: canceling statement due to statement timeout`** — nao e o pooler, e o limite de 2 min do
  papel. Falta `SET statement_timeout = 0` na invocacao (Passo 2). Trocar de host nao resolve.
- **`server closed the connection unexpectedly`**, `SSL connection has been closed`, ou o arquivo
  para de crescer — aí sim e o pooler, que nao e feito para transferencias longas. A saida e o host
  direto, que funciona por IPv6 da maquina de trabalho (testado) e nao passa por Supavisor.

Nos dois casos, descarte o arquivo truncado antes de repetir: `rm -f "$BKP/02-raw_payloads.csv.gz"`.

```bash
export OMS_DIRECT_URL="$(npx tsx -e "
import {config} from 'dotenv'; config({path:'.env'});
const u=new URL(process.env.OMS_DB_URL);
const ref=decodeURIComponent(u.username).split('.')[1];
console.log('postgresql://postgres:'+u.password+'@db.'+ref+'.supabase.co:5432/postgres');
" 2>/dev/null | tail -1)"
```

Repita o Passo 4 trocando `"$OMS_URL"` por `"$OMS_DIRECT_URL"` — muda so a conexao; consulta,
recorte e verificacao sao os mesmos.

### Fatiamento — o caminho que de fato termina

Em vez de uma consulta de mais de uma hora, varias curtas. Mesmo custo total (o gargalo e
transferencia, nao varredura), mas **uma queda custa uma fatia em vez de tudo**, e o loop **retoma**:
fatia ja baixada e integra e pulada, entao a correcao de uma falha e reexecutar o mesmo comando.

**Semanal e o que foi validado ponta a ponta** (tabela abaixo) — comece por ele. O loop diario a
seguir e a versao mais granular, para quando uma semana nao vencer.

```bash
caffeinate -i bash -c '
for i in $(seq 0 30); do
  ini="$(date -j -v+${i}d -f %Y-%m-%d 2026-08-01 +%Y-%m-%d)"
  fim="$(date -j -v+$((i+1))d -f %Y-%m-%d 2026-08-01 +%Y-%m-%d)"
  arq="$BKP/02-raw_payloads-$ini.csv.gz"
  if gzip -t "$arq" 2>/dev/null; then echo "ja pronto: $ini"; continue; fi
  echo "--- $ini -> $fim"
  t0=$SECONDS
  psql -q "$OMS_URL" \
    -c "SET statement_timeout = 0" \
    -c "SET default_transaction_read_only = on" \
    -c "\copy (SELECT * FROM public.raw_payloads WHERE COALESCE(received_at,processed_at) >= '"'"'$ini 00:00:00-03'"'"'::timestamptz AND COALESCE(received_at,processed_at) < '"'"'$fim 00:00:00-03'"'"'::timestamptz) TO STDOUT CSV HEADER" \
    | gzip -6 > "$arq" \
    && gzip -t "$arq" && echo "    OK: $(( $(gzcat "$arq" | wc -l) - 1 )) linhas, $(du -h "$arq" | cut -f1), $((SECONDS-t0))s" \
    || { echo "    FALHOU: $ini (descartado)"; rm -f "$arq"; }
done
'
```

`seq 0 30` cobre 01/08 a 31/08 com o ultimo limite em `2026-09-01`: mes fechado, nada de setembro.
Dias sem dado saem vazios em ~40 s. Trocar `$OMS_URL` por `$OMS_DIRECT_URL` no loop e a combinacao
mais robusta.

Para fatias semanais, troque o gerador de datas por `+7d` — o resto e igual, muda so o custo de uma
queda. **Execucao completa em fatias semanais, 2026-08-20, sem uma queda:**

| fatia | linhas | tamanho | tempo |
|---|---|---|---|
| 01/08 → 08/08 | 170.867 | 142 MB | 1.652 s |
| 08/08 → 15/08 | 188.171 | 166 MB | 1.398 s |
| 15/08 → 22/08 | 161.901 | 131 MB | 473 s |
| 22/08 → 29/08 | 0 | 4 KB | 88 s |
| 29/08 → 01/09 | 0 | 4 KB | 103 s |
| **total** | **520.939** | **~440 MB** | **62 min** |

Semanal e viavel; o que nao completa e o mes inteiro de uma vez. Note a vazao **muito instavel** —
a terceira fatia foi 3x mais rapida que a primeira com volume parecido, entao trate qualquer
estimativa de tempo como ordem de grandeza, nao previsao.

> **A retomada nao atualiza fatia da cauda.** A fatia que cobre "hoje" fica congelada no instante em
> que rodou; linhas que chegaram depois nao entram. Como o loop pula arquivo que ja existe, uma
> reexecucao **nao** corrige isso. Para fechar o mes depois de 01/09, apague antes as fatias da cauda
> (`rm -f "$BKP/02-raw_payloads-2026-08-15.csv.gz" ...`) e rode de novo.

> **Nao cole estes comandos com comentario `#` no fim da linha.** O zsh desta maquina nao tem
> `interactive_comments` ligado: ele trata `#` e o que vem depois como nomes de arquivo, e um `~`
> solto como diretorio de usuario. Aconteceu na execucao de 2026-08-20.

Verificacao do conjunto fatiado, ja que cada arquivo tem seu proprio header CSV:

Nao cole com comentario `#` (ver aviso acima). Contagem de arquivos, integridade, linhas por fatia,
total e checksums:

```bash
ls -lh "$BKP"/02-raw_payloads-2026-08-*.csv.gz
for f in "$BKP"/02-raw_payloads-2026-08-*.csv.gz; do
  gzip -t "$f" && echo "ok   $(basename "$f")" || echo "CORROMPIDO $(basename "$f")"
done
for f in "$BKP"/02-raw_payloads-2026-08-*.csv.gz; do
  echo "$(basename "$f"): $(( $(gzcat "$f" | wc -l) - 1 ))"
done
gzcat "$BKP"/02-raw_payloads-2026-08-*.csv.gz | grep -vc '^id,'
( cd "$BKP" && shasum -a 256 *.csv.gz > SHA256SUMS.txt && cat SHA256SUMS.txt )
du -sh "$BKP"
```

O `grep -vc '^id,'` desconta o header de cada fatia. Na restauracao, carregue um arquivo por vez.

### Cruzamento com o banco — o unico check que prova o recorte

O `gzip -t` prova que a transferencia nao truncou; ele nao prova que o recorte pegou o conjunto certo
de linhas. Para isso, conte no banco as **semanas ja fechadas no passado** — imutaveis, portanto tem
de bater **exatamente**. A fatia que cobre o dia corrente nao serve para este check (ver a ressalva
da cauda).

```bash
psql -q "$OMS_URL" \
  -c "SET statement_timeout = 0" \
  -c "SET default_transaction_read_only = on" \
  -Atc "SELECT count(*) FILTER (WHERE COALESCE(received_at,processed_at) < '2026-08-08 00:00:00-03'::timestamptz) AS semana1, count(*) FILTER (WHERE COALESCE(received_at,processed_at) >= '2026-08-08 00:00:00-03'::timestamptz) AS semana2 FROM public.raw_payloads WHERE COALESCE(received_at,processed_at) >= '2026-08-01 00:00:00-03'::timestamptz AND COALESCE(received_at,processed_at) < '2026-08-15 00:00:00-03'::timestamptz"
```

Uma varredura so, ~1-2 min. Na execucao de 2026-08-20 saiu `170867|188171`, **identico as duas
primeiras fatias** — e o que prova recorte, fuso e integridade de uma vez.

## Evidencias — o que foi medido contra o banco real em 2026-08-20

Tudo com `SET default_transaction_read_only = on`, sem uma escrita no OMS:

- **Volumetria da janela aberta**: 519.879 linhas, `min = 2026-08-01 00:00:25-03`,
  `max = 2026-08-20 15:57:15-03`.
- **Escorregao de fuso quantificado**: mesmo filtro em UTC deu 523.768 — 3.889 linhas a mais, de
  31 de julho.
- **Pooler descarta `PGTZ`/`PGOPTIONS`**: sessao voltou `UTC|off` com as duas exportadas.
- **`SET` por `-c` funciona**: `CREATE TEMP TABLE` recusado com
  `cannot execute CREATE TABLE in a read-only transaction`; e a dupla
  `statement_timeout`/`read_only` leu de volta `0 | on`.
- **`statement_timeout` do papel `postgres` e 2 min** (`SHOW statement_timeout` → `2min`) — e uma
  execucao real do Passo 4 sem o `SET` morreu com
  `ERROR: canceling statement due to statement timeout`.
- **O `\copy` unico do mes nao termina pelo pooler**: com o timeout desarmado, a segunda tentativa
  caiu com `COPY data transfer failed: SSL connection has been closed unexpectedly`. Foi o que moveu
  o fatiamento de fallback para caminho principal.
- **Execucao completa em fatias semanais**: 520.939 linhas, ~440 MB, 62 min, sem uma queda — a
  extracao que este runbook descreve foi de fato realizada.
- **Vazao por fatia diaria**: 19/08 → 29.276 linhas, 25 MB, 263 s; 20/08 → 36.526 linhas, 26 MB,
  307 s. O tempo escala com linhas (fatia de 4 h: 49 s), entao a varredura sozinha custa ~40 s.
- **Retomada do loop funciona**: segunda passada sobre as mesmas duas fatias pulou as duas.
- **Cruzamento final com o banco**: as duas semanas fechadas deram `170867|188171`, identico as duas
  primeiras fatias. Recorte, fuso e integridade provados.
- **Conferencia local**: `gzip -t` OK nos 5 arquivos, header `id,source,external_order_id,...` intacto
  em todos (nenhum `SET`), total 520.939 linhas, 438 MB, `SHA256SUMS.txt` gravado no destino.
- **Geracao das datas**: `date -j -v+${i}d -f %Y-%m-%d 2026-08-01` confere na sintaxe BSD do macOS,
  com `seq 0 30` fechando exatamente em `2026-09-01`.
- **`-q` e obrigatorio**: sem ele, a linha `SET` entrou no CSV antes do header.
- **`pg_dump --schema-only --table=public.raw_payloads`**: rodou de cliente 18.6 contra servidor
  17.6, 86 linhas de DDL, revelando os indices, o trigger desabilitado e a RLS citados no Passo 3.
- **Pipeline ponta a ponta**, com os comandos dos Passos 4 e 5 exatamente como estao escritos, so
  com `DESDE` recente para o resultado ficar pequeno: janela aberta de 4 h → 2.806 linhas, 2,2 MB de
  `.csv.gz`, 49 s, `gzip -t` OK, sem contaminacao de `SET`, e a contagem do banco com teto em `T0`
  deu 2.805 (a relacao esperada).
- **Taxa de compressao observada**: ~800 B por linha comprimida contra ~6,9 kB de texto — ~8,6x, que
  e de onde vem a estimativa de ~0,4-0,6 GB para as ~520 mil linhas.

## O que este backup NAO e

- **Nao e o OMS.** E uma tabela — `public.raw_payloads` — a partir de 2026-08-01. Nem outras
  tabelas, nem julho ou antes, nem roles, nem o schema `integration`.
- **Nao e PITR.** O `COPY` e uma unica consulta, entao **este arquivo e um snapshot consistente da
  tabela** no instante em que a consulta comecou — mas segue sendo um dump logico de um objeto so.
  Para recuperacao point-in-time do banco, o recurso e o backup gerenciado no painel da Supabase.
- **Nao substitui o espelho.** Ver `docs/PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md`: isto e copia
  de seguranca, nao sincronizacao.
- **Nao carrega as politicas de RLS** nem a funcao do trigger que o DDL referencia (Passo 3): a
  restauracao exige tratar as duas coisas a mao.
