---
name: backup-oms-raw-payloads
description: Extrai copia de seguranca de tabelas do OMS (Supabase de outro time, read-only) para arquivo local, recortada por periodo. Use quando o pedido envolver backup, dump, export, extracao ou download de dados do OMS — especialmente `public.raw_payloads` — ou quando um `\copy`/`pg_dump` contra o OMS falhar com `statement timeout` ou `SSL connection has been closed unexpectedly`. Traz os quatro comportamentos do pooler Supavisor que fazem o procedimento ingenuo falhar ou, pior, produzir arquivo silenciosamente errado.
---

# Backup de tabela do OMS por periodo

Procedimento validado em execucao real (2026-08-20: 520.939 linhas de `raw_payloads` de agosto/2026,
438 MB, 62 min, conferido contra o banco). Detalhe completo, medicoes e arestas em
[docs/RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md](../../../docs/RUNBOOK-BACKUP-OMS-SUPABASE-CLI.md).

**O OMS e producao de outro time e read-only para nos.** Todo comando aqui e `SELECT`.

Pre-requisitos: `.env` com `OMS_DB_URL` na raiz do repo, `brew` (macOS) ou `postgresql-client`
(Linux), e destino com espaco. O destino default e `/Volumes/externo-ugreen`; sobreponha com
`export BACKUP_DEST=/outro/caminho` antes de comecar.

## As quatro coisas que fazem o caminho obvio falhar

Cada uma custou uma tentativa perdida. Nao pule nenhuma.

1. **A CLI da Supabase nao serve para recorte.** `supabase db dump` recorta por schema — tem
   `--schema` e `--exclude schema.tabela`, mas **nao tem `--table` para incluir uma tabela so, nem
   `--where`**. Nem `pg_dump` filtra linha. Recorte por periodo exige `psql` com
   `\copy (SELECT ... WHERE ...) TO STDOUT`. Para o DDL de uma tabela so, `pg_dump --schema-only
   --table=`.
2. **O pooler descarta `PGOPTIONS` e `PGTZ`.** Exportar as duas nao tem efeito nenhum: a sessao volta
   `UTC|off`. Passe por `-c` na mesma invocacao do `psql`, que **funciona**.
3. **`statement_timeout` do papel `postgres` e 2 min.** Sem `SET statement_timeout = 0`, qualquer
   extracao real morre com `ERROR: canceling statement due to statement timeout`.
4. **Fuso vai no literal, nunca na sessao.** Use `'2026-08-01 00:00:00-03'::timestamptz`. Confiar em
   fuso de sessao move a borda 3 h **em silencio** — medido: o mesmo filtro em UTC trouxe 3.889
   linhas de 31/07 como se fossem de agosto. O Brasil nao tem horario de verao, `-03` e estavel.

E uma consequencia das quatro: **`-q` e obrigatorio** no `psql`. Sem ele os `SET` imprimem a linha
`SET` no stdout, que entra no arquivo antes do header CSV e o corrompe.

## Passo 1 — ambiente

Nada aqui e fixo na maquina: a raiz vem do git, o `psql` vem do `brew`, e o destino tem default mas
respeita `BACKUP_DEST`.

```bash
ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
  echo "ERRO: rode este bloco de dentro do repositorio"
else
  cd "$ROOT"
  set -a && . ./.env && set +a
  export OMS_URL="$OMS_DB_URL"
  [ -n "$OMS_URL" ] && echo "raiz: $PWD | OMS_URL definida (${#OMS_URL} caracteres)" \
                    || echo "ERRO: OMS_DB_URL ausente no .env"
fi
```

```bash
brew --prefix libpq >/dev/null 2>&1 || brew install libpq
export PATH="$(brew --prefix libpq)/bin:$PATH"
psql --version
```

```bash
export BACKUP_DEST="${BACKUP_DEST:-/Volumes/externo-ugreen}"
export BKP="$BACKUP_DEST/backup-raw_payloads-$(date +%Y%m%d-%H%M)"
mkdir -p "$BKP" && echo "destino: $BKP" && df -h "$BACKUP_DEST" | tail -1
```

**A guarda do `ROOT` nao e paranoia.** Sem ela, `cd "$(git rev-parse ...)"` fora do repo falha em
silencio: a substituicao vira vazia, `cd ""` nao sai do lugar, o `.env` nao carrega e o `psql` termina
tentando um socket local em vez do OMS. Verificado.

`psql` nao vem no macOS e vem dentro do `libpq`, que o Homebrew instala sem colocar no `PATH` — daí o
`brew --prefix`. Cliente mais novo que o servidor esta correto: `\copy` e do lado do cliente, nao ha
formato de dump envolvido. Em Linux, troque as duas linhas do `brew` por `postgresql-client` do
gerenciador de pacotes.

**Confira o espaco** na saida do `df` acima: agosto/2026 deu 438 MB comprimidos, e um periodo maior
escala proporcional.

Se o `mkdir` ou um `ls` no destino der `Operation not permitted` em macOS com volume externo, e o
TCC: libere o Terminal em **Ajustes → Privacidade e Seguranca → Arquivos e Pastas**. Descobrir isso
depois de uma hora de dump e o pior momento possivel.

Smoke test que valida credencial, rede, recorte e read-only de uma vez:

```bash
psql -q "$OMS_URL" \
  -c "SET statement_timeout = 0" \
  -c "SET default_transaction_read_only = on" \
  -Atc "SELECT count(*) FROM public.raw_payloads WHERE COALESCE(received_at,processed_at) >= '2026-08-01 00:00:00-03'::timestamptz AND COALESCE(received_at,processed_at) < '2026-09-01 00:00:00-03'::timestamptz"
```

## Passo 2 — DDL da tabela

```bash
pg_dump "$OMS_URL" --schema-only --table=public.raw_payloads \
  --no-owner --no-privileges -f "$BKP/01-schema-raw_payloads.sql"
```

Duas coisas que este DDL carrega e que quebram a restauracao: o trigger
`trg_raw_payloads_sync`, que chama `integration.capture_raw_payloads_changes()` (falha em banco que
nao tenha a funcao), e `ENABLE ROW LEVEL SECURITY` sem as politicas (tabela invisivel para quem nao
for owner nem `BYPASSRLS`).

## Passo 3 — dados, em fatias

**Nao tente o mes inteiro num `\copy`.** Foi tentado duas vezes e nao terminou: a primeira no
timeout, a segunda com `COPY data transfer failed: SSL connection has been closed unexpectedly`.
Fatie. O loop **retoma** — fatia ja baixada e integra e pulada, entao a correcao de uma queda e
reexecutar o mesmo comando.

Semanal e o que rodou inteiro sem queda (~25 min por fatia de ~180 mil linhas):

```bash
caffeinate -i bash -c '
while read -r ini fim; do
  [ -z "$ini" ] && continue
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
done <<FATIAS
2026-08-01 2026-08-08
2026-08-08 2026-08-15
2026-08-15 2026-08-22
2026-08-22 2026-08-29
2026-08-29 2026-09-01
FATIAS
'
```

O ultimo limite fecha o mes exato — nada do mes seguinte entra. Fatias sem dado saem com so o header,
em ~90 s. Se uma semana nao vencer, troque a lista por dias; o loop e o mesmo. Vazao e **instavel**
(100 a 340 linhas/s em fatias de volume parecido, na mesma execucao), entao trate estimativa de tempo
como ordem de grandeza.

Se cair repetidamente, o host direto nao passa por Supavisor (IPv6, funciona da maquina de trabalho):

```bash
export OMS_DIRECT_URL="$(npx tsx -e "
import {config} from 'dotenv'; config({path:'.env'});
const u=new URL(process.env.OMS_DB_URL);
const ref=decodeURIComponent(u.username).split('.')[1];
console.log('postgresql://postgres:'+u.password+'@db.'+ref+'.supabase.co:5432/postgres');
" 2>/dev/null | tail -1)"
```

## Passo 4 — verificacao

Nao cole comandos com comentario `#` no fim da linha: o zsh desta maquina nao tem
`interactive_comments`, entao trata `#` e o que vem depois como nomes de arquivo.

```bash
for f in "$BKP"/02-raw_payloads-*.csv.gz; do
  gzip -t "$f" && echo "ok   $(basename "$f"): $(( $(gzcat "$f" | wc -l) - 1 )) linhas" \
               || echo "CORROMPIDO $(basename "$f")"
done
for f in "$BKP"/02-raw_payloads-*.csv.gz; do gzcat "$f" | head -1 | cut -c1-40; done
gzcat "$BKP"/02-raw_payloads-*.csv.gz | grep -vc '^id,'
( cd "$BKP" && shasum -a 256 *.csv.gz > SHA256SUMS.txt && cat SHA256SUMS.txt )
du -sh "$BKP"
```

Todo header tem de comecar em `id,source,external_order_id,...`; header `SET` significa que o `-q`
foi perdido.

**O `gzip -t` prova que nao truncou, nao que o recorte esta certo.** Para provar o recorte, conte no
banco as **semanas ja fechadas no passado** — imutaveis, logo tem de bater exatamente com as fatias
correspondentes. Uma varredura so:

```bash
psql -q "$OMS_URL" \
  -c "SET statement_timeout = 0" \
  -c "SET default_transaction_read_only = on" \
  -Atc "SELECT count(*) FILTER (WHERE COALESCE(received_at,processed_at) < '2026-08-08 00:00:00-03'::timestamptz) AS semana1, count(*) FILTER (WHERE COALESCE(received_at,processed_at) >= '2026-08-08 00:00:00-03'::timestamptz) AS semana2 FROM public.raw_payloads WHERE COALESCE(received_at,processed_at) >= '2026-08-01 00:00:00-03'::timestamptz AND COALESCE(received_at,processed_at) < '2026-08-15 00:00:00-03'::timestamptz"
```

Em 2026-08-20 saiu `170867|188171`, identico as duas primeiras fatias.

## A ressalva da cauda

A fatia que cobre o dia corrente fica **congelada no instante em que rodou**; linhas que chegam
depois nao entram. E a retomada **nao corrige isso**, porque pula arquivo que ja existe. Para fechar
um mes ainda aberto, reexecute depois do virar do mes **apagando antes as fatias da cauda**:

```bash
rm -f "$BKP/02-raw_payloads-2026-08-15.csv.gz" "$BKP/02-raw_payloads-2026-08-22.csv.gz"
```

## Adaptar para outra tabela ou periodo

- **Outro periodo**: troque a lista de fatias e os literais. Sempre `>=` no inicio e `<` no fim, com
  offset `-03`.
- **Outra tabela**: confira antes qual e a coluna de tempo — nao presuma `created_at`. No OMS,
  `order_items` **nao tem coluna de data** e `order_shipments` **nao tem `created_at`**; as duas so
  se recortam pelo pedido pai (`order_id` → `orders.internal_order_id`, que e a PK, nao `id`).
  `customers` esta vazia. Consulte `information_schema.columns` em vez de adivinhar.
- **Custo no OMS**: `raw_payloads` **nao tem indice em `received_at`**, entao cada fatia e um seq scan
  de ~6 GB (~40 s). Fatia diaria custa mais varredura que semanal; o gargalo, ainda assim, e
  transferencia. **Nao rode junto com o dreno de recuperacao do mirror** — carga concorrente ja
  causou `statement timeout` nesse banco.
