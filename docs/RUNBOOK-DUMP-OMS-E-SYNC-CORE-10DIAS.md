# Runbook Operacional: Dump OMS + Sync CORE (10 dias)

Data: 2026-07-01  
Status: pronto para execução

> **Atualização 2026-08-18 — as Fases 1, 2 e 3 foram substituídas por um script, por restrição de
> ambiente.** `psql` e `pg_dump` **não estão instalados** nesta máquina (somente `wrangler`), e o
> disco está a 97% de uso (16 GB livres de 460 GB) — contra uma janela de 448.218 linhas com payload
> de 10-30KB cada, que não caberia em CSV. O caminho em uso é
> [scripts/backfill-mirror-window.ts](../scripts/backfill-mirror-window.ts), que faz OMS -> CORE por
> UPSERT em lotes **sem arquivo intermediário**: mesmas 10 colunas, mesmo
> `ON CONFLICT (id) DO UPDATE`, `synced_at`/`mirror_updated_at` do lado do CORE — o mesmo resultado
> das Fases 2 e 3, sem CSV e sem consumo de disco.
>
> **A Fase 1 (dump completo com `--column-inserts`) foi deliberadamente pulada.** Justificativa:
> (a) a operação **não escreve nada no OMS** — é `SELECT` puro, então não há o que perder na origem;
> (b) no CORE, o UPSERT sobrescreve linhas de `mirror.raw_payloads` com os valores do OMS, o que é
> por definição um **reparo do read model**, não perda de dado — o mirror é derivado do OMS, não
> fonte de verdade; (c) `pg_dump` não está disponível e `--column-inserts` sobre a tabela inteira
> encheria o volume. Não é descuido: é uma decisão registrada.
>
> As **Fases 0 e 4 seguem válidas** (validação de contagem OMS vs CORE com o mesmo filtro) — e o
> script já as executa internamente, contando os dois lados antes e depois.
>
> **Passo que este runbook não tem e é obrigatório:** avançar
> `integration.sync_watermark` depois da carga. Ver §2.4 Passo 1b em
> [PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md](PLAN-CORRECAO-CONSUMO-E-MATERIALIZACAO.md) — sem isso
> o ciclo incremental fica preso atrás da região carregada.

## Objetivo
1. Gerar backup completo de dados da tabela `public.raw_payloads` no OMS.
2. Sincronizar para o CORE somente os registros dos últimos 10 dias de `raw_payloads`.

## Premissas
- OMS deve ser usado somente para leitura neste procedimento.
- Escrita permitida apenas no CORE.
- Execução em ambiente com `pg_dump` e `psql` instalados.

## Variáveis de ambiente
Antes de iniciar, exporte as conexões:

```bash
export OMS_DB_URL='postgresql://postgres:SENHA@db.reteifdxylxquwlrhqdq.supabase.co:5432/postgres?sslmode=require'
export CORE_DB_URL='postgresql://USUARIO:SENHA@HOST_CORE:5432/NOME_DB_CORE?sslmode=require'
```

Opcional (evitar prompt de senha no `pg_dump`):

```bash
export PGPASSWORD='SENHA_DO_POSTGRES_OMS'
```

## Fase 0 - Preparação
1. Na raiz do projeto, criar pasta de trabalho:

```bash
mkdir -p tmp/oms-export
```

2. Validar ferramentas:

```bash
pg_dump --version
psql --version
```

## Fase 1 - Dump completo OMS raw_payloads
Executar o dump completo solicitado (data-only, com inserts por coluna):

```bash
pg_dump \
  -h db.reteifdxylxquwlrhqdq.supabase.co \
  -p 5432 \
  -d postgres \
  -U postgres \
  --table="public.raw_payloads" \
  --data-only \
  --column-inserts \
  > tmp/oms-export/raw_payloads_rows.sql
```

Gerar checksum e compactar:

```bash
shasum -a 256 tmp/oms-export/raw_payloads_rows.sql > tmp/oms-export/raw_payloads_rows.sql.sha256
gzip -9 tmp/oms-export/raw_payloads_rows.sql
```

Saídas esperadas:
- `tmp/oms-export/raw_payloads_rows.sql.gz`
- `tmp/oms-export/raw_payloads_rows.sql.sha256`

## Fase 2 - Exportar OMS dos últimos 10 dias
Exportar CSV somente com janela de 10 dias:

```bash
psql "$OMS_DB_URL" -c "\copy ( \
  SELECT \
    id, source, external_order_id, event_type, payload_json, headers_json, \
    received_at, processed_at, processing_status, error_message \
  FROM public.raw_payloads \
  WHERE COALESCE(received_at, processed_at) >= NOW() - INTERVAL '10 days' \
) TO 'tmp/oms-export/raw_payloads_last10d.csv' CSV HEADER"
```

Saída esperada:
- `tmp/oms-export/raw_payloads_last10d.csv`

## Fase 3 - Carga no CORE com UPSERT
Executar carga em tabela temporária e UPSERT para `mirror.raw_payloads`:

```bash
psql "$CORE_DB_URL" <<'SQL'
BEGIN;

CREATE TEMP TABLE tmp_raw_payloads_last10d (
  id uuid,
  source text,
  external_order_id text,
  event_type text,
  payload_json jsonb,
  headers_json jsonb,
  received_at timestamptz,
  processed_at timestamptz,
  processing_status text,
  error_message text
);

\copy tmp_raw_payloads_last10d (
  id, source, external_order_id, event_type, payload_json, headers_json,
  received_at, processed_at, processing_status, error_message
) FROM 'tmp/oms-export/raw_payloads_last10d.csv' CSV HEADER

INSERT INTO mirror.raw_payloads (
  id,
  source,
  external_order_id,
  event_type,
  payload_json,
  headers_json,
  received_at,
  processed_at,
  processing_status,
  error_message,
  synced_at,
  mirror_updated_at
)
SELECT
  id,
  source,
  external_order_id,
  event_type,
  payload_json,
  headers_json,
  received_at,
  processed_at,
  processing_status,
  error_message,
  NOW(),
  NOW()
FROM tmp_raw_payloads_last10d
ON CONFLICT (id)
DO UPDATE SET
  source = EXCLUDED.source,
  external_order_id = EXCLUDED.external_order_id,
  event_type = EXCLUDED.event_type,
  payload_json = EXCLUDED.payload_json,
  headers_json = EXCLUDED.headers_json,
  received_at = EXCLUDED.received_at,
  processed_at = EXCLUDED.processed_at,
  processing_status = EXCLUDED.processing_status,
  error_message = EXCLUDED.error_message,
  synced_at = NOW(),
  mirror_updated_at = NOW();

COMMIT;
SQL
```

## Fase 4 - Validação pós-carga
1. Contagem OMS (janela 10 dias):

```bash
psql "$OMS_DB_URL" -c "SELECT COUNT(*) AS oms_10d FROM public.raw_payloads WHERE COALESCE(received_at, processed_at) >= NOW() - INTERVAL '10 days';"
```

2. Contagem CORE (janela 10 dias):

```bash
psql "$CORE_DB_URL" -c "SELECT COUNT(*) AS core_10d FROM mirror.raw_payloads WHERE COALESCE(received_at, processed_at) >= NOW() - INTERVAL '10 days';"
```

3. Amostra de conferência no CORE:

```bash
psql "$CORE_DB_URL" -c "SELECT id, source, received_at, processed_at FROM mirror.raw_payloads WHERE COALESCE(received_at, processed_at) >= NOW() - INTERVAL '10 days' ORDER BY COALESCE(received_at, processed_at) DESC LIMIT 20;"
```

## Checklist de conclusão
- [ ] Dump completo gerado e compactado
- [ ] Checksum SHA-256 gerado
- [ ] CSV de 10 dias exportado do OMS
- [ ] UPSERT executado no CORE sem erro
- [ ] Contagens OMS e CORE conferidas
- [ ] Amostra por ID validada

## Troubleshooting rápido
1. Erro de autenticação no `pg_dump` ou `psql`:
- Verificar usuário/senha e se `sslmode=require` está presente na URL.

2. Erro de permissão no OMS:
- Confirmar que o usuário tem permissão de leitura em `public.raw_payloads`.

3. Erro de tipo no `COPY` para JSON:
- Verificar se o CSV foi gerado com `CSV HEADER` e se não houve edição manual do arquivo.

4. Divergência de contagem OMS vs CORE:
- Confirmar se a comparação usa exatamente o mesmo filtro temporal (`COALESCE(received_at, processed_at) >= NOW() - INTERVAL '10 days'`).
- Validar timezone da sessão SQL.

## Evidências mínimas para auditoria
Salvar os seguintes artefatos:
1. Comandos executados (histórico ou log da operação).
2. Arquivos gerados em `tmp/oms-export`.
3. Resultado das consultas de contagem OMS e CORE.
4. Horário de início/fim da execução.
