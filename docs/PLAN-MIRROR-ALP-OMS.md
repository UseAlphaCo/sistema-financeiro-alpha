# Plano de Arquitetura — ALP-OMS → ALP-CORE

## Objetivo

Construir um novo sistema desacoplado do legado `ALP-OMS`, utilizando:

- réplica controlada dos dados necessários
- isolamento arquitetural
- segurança
- alta performance
- escalabilidade futura
- baixo impacto no OMS

---

# Arquitetura Final

```text
ALP-OMS (Supabase)
   └── public.tabela_origem
            ↓
      eventos de sync
            ↓
       Sync Worker
            ↓
ALP-CORE (Supabase)
   ├── mirror.*
   ├── app.*
   ├── integration.*
   ├── audit.*
   ├── auth
   └── storage
```

---

# Estrutura do Projeto ALP-CORE

## 1. Schemas

### Schema `mirror`

Responsabilidade:
- réplica readonly do OMS

Exemplo:

```sql
mirror.orders
mirror.customers
mirror.products
```

---

### Schema `app`

Responsabilidade:
- domínio da aplicação

Exemplo:

```sql
app.users
app.entries
app.outputs
app.categories
app.settings
app.permissions
```

---

### Schema `integration`

Responsabilidade:
- sincronização
- filas
- eventos
- controle técnico

Exemplo:

```sql
integration.sync_events
integration.sync_control
integration.failed_jobs
integration.webhooks
```

---

### Schema `audit`

Responsabilidade:
- auditoria
- rastreabilidade
- compliance

Exemplo:

```sql
audit.logs
audit.user_actions
audit.sync_history
```

---

# Fluxo de Dados

## Fluxo principal

```text
ALP-OMS
   ↓
trigger/event
   ↓
integration.sync_events
   ↓
Sync Worker
   ↓
ALP-CORE.mirror
   ↓
Backend/API
   ↓
ALP-CORE.app
```

---

# Estratégia de Sincronização (CDC)

## Recomendação

Implementar CDC baseado em eventos + worker incremental.

Essa é a abordagem mais segura dentro do Supabase.

---

# Estrutura no ALP-OMS

## Adicionar coluna

Na tabela sincronizada:

```sql
updated_at TIMESTAMP
```

---

# Criar tabela de eventos

```sql
CREATE SCHEMA integration;
```

```sql
CREATE TABLE integration.sync_events (
  id BIGSERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload JSONB,
  processed BOOLEAN DEFAULT FALSE,
  retries INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP
);
```

---

# Trigger automática

## Objetivo

Registrar:
- INSERT
- UPDATE
- DELETE

---

## Exemplo

```sql
CREATE OR REPLACE FUNCTION integration.capture_changes()
RETURNS TRIGGER AS $$
BEGIN

  INSERT INTO integration.sync_events (
    table_name,
    record_id,
    operation,
    payload
  )
  VALUES (
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id)::TEXT,
    TG_OP,
    to_jsonb(COALESCE(NEW, OLD))
  );

  RETURN NEW;

END;
$$ LANGUAGE plpgsql;
```

---

# Vincular trigger

```sql
CREATE TRIGGER trg_orders_sync
AFTER INSERT OR UPDATE OR DELETE
ON public.orders
FOR EACH ROW
EXECUTE FUNCTION integration.capture_changes();
```

---

# Estrutura do ALP-CORE

## Mirror

```sql
CREATE TABLE mirror.orders (
  id BIGINT PRIMARY KEY,
  customer_id BIGINT,
  status TEXT,
  total NUMERIC,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  synced_at TIMESTAMP DEFAULT NOW()
);
```

---

# Sistema principal (`app`)

## Tabelas principais

### Usuários

```sql
app.users
```

Campos:
- id
- auth_user_id
- name
- email
- role
- created_at

---

### Categorias

```sql
app.categories
```

---

### Entradas

```sql
app.entries
```

Relaciona:
- usuário
- categoria
- registro mirror

---

### Saídas

```sql
app.outputs
```

---

# Estratégia de relacionamento

## NUNCA alterar o mirror

O mirror é readonly.

---

## Relacionamento correto

```sql
app.entries
  └── mirror_order_id
```

---

# Backend Recomendado

| Camada | Tecnologia |
|---|---|
| Frontend | Next.js |
| API | Laravel |
| Banco | PostgreSQL |
| Infra | Supabase |
| Cache | Redis |
| Worker | Node.js / Cloudflare Worker |

---

# Estrutura do Backend

```text
backend/
 ├── api/
 ├── workers/
 ├── jobs/
 ├── integrations/
 ├── domain/
 ├── repositories/
 └── services/
```

---

# Worker de Sync

## Responsabilidades

- ler eventos
- validar
- aplicar UPSERT
- registrar erros
- retry automático

---

# Fluxo

```text
sync_events
    ↓
worker
    ↓
upsert mirror
    ↓
mark processed
```

---

# UPSERT obrigatório

```sql
INSERT ...
ON CONFLICT DO UPDATE
```

---

# Segurança

## Roles

### Role sync

Permissões:
- leitura OMS
- escrita mirror

---

### Role app

Permissões:
- leitura mirror
- CRUD app

---

# RLS

## Ativar SOMENTE no schema `app`

Nunca no:
- mirror
- integration

---

# Auditoria

## Criar log de ações

```sql
audit.user_actions
```

Campos:
- user_id
- action
- entity
- entity_id
- payload
- ip
- created_at

---

# Estratégia de IDs

## Sempre usar:

```text
id interno
external_id legado
```

---

## Exemplo

```sql
id UUID PRIMARY KEY
external_id BIGINT
```

---

# Observabilidade

## Logs obrigatórios

- sync success
- sync error
- latency
- retries
- queue depth

---

# Ferramentas

- Sentry
- Logtail
- Grafana
- Supabase Logs

---

# Retry automático

| Tentativa | Delay |
|---|---|
| 1 | imediato |
| 2 | 30s |
| 3 | 5min |
| 4 | 15min |

Após:
- dead letter queue

---

# Escalabilidade futura

Preparado para:

- microserviços
- múltiplas tabelas mirror
- multi-tenant
- BI
- analytics
- Kafka
- Debezium
- event sourcing

---

# Roadmap de implementação

## FASE 1 — Fundação

### Objetivo

Criar infraestrutura base.

### Tarefas

- criar projeto `ALP-CORE`
- criar schemas
- criar roles
- configurar auth
- configurar secrets

---

## FASE 2 — CDC

### Objetivo

Implementar sincronização.

### Tarefas

- criar `sync_events`
- criar triggers
- criar worker
- criar upserts
- testes de carga

---

## FASE 3 — Backend

### Objetivo

Construir API.

### Tarefas

- auth
- users
- categorias
- entradas
- saídas
- auditoria

---

## FASE 4 — Frontend

### Objetivo

Construir painel.

### Tarefas

- login
- dashboards
- CRUDs
- filtros
- relatórios

---

## FASE 5 — Observabilidade

### Objetivo

Garantir confiabilidade.

### Tarefas

- logs
- alertas
- métricas
- retries
- dead letter queue

---

# Resultado Final

Você terá uma arquitetura:

- enterprise-grade
- desacoplada
- segura
- auditável
- escalável
- resiliente
- performática
- preparada para crescimento
- sem dependência direta do OMS
- com baixo impacto no legado
- pronta para evolução futura no Supabase
