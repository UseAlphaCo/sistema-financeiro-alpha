# Playbook: Deploy Worker Persistence (CORE)

Objetivo: disponibilizar a persistência de jobs em `integration.worker_sync_jobs` no ALP-CORE-FIN e colocar o sistema em modo `mirror-first` para validação em produção.

Pré-requisitos
- Acesso SSH/CI ao servidor de produção
- Variáveis de ambiente configuradas: `CORE_DB_URL`, `OMS_DB_URL`, `FINANCIAL_READ_MODEL_MIRROR=true`, `DISABLE_SHOPIFY_WEBHOOKS=true`, `SHOPIFY_WEBHOOK_SECRET`
- Backup do banco Core antes de rodar migrações

Passos de release (máquina de deploy / CI)

1. Atualizar repositório e instalar dependências

```bash
git pull origin main
npm ci
npm run prisma:generate
```

2. Rodar migrations (prisma)

```bash
# com prisma migrate
npx prisma migrate deploy --schema prisma/schema.prisma
# ou aplicar SQL diretamente
psql "$CORE_DB_URL" -f prisma/migrations/20260603_add_worker_sync_jobs/migration.sql
```

3. Ajustar variáveis de ambiente

- `FINANCIAL_READ_MODEL_MIRROR=true`
- `DISABLE_SHOPIFY_WEBHOOKS=true`
- Conferir `CORE_DB_URL` e `OMS_DB_URL` apontando para os DBs corretos

4. Reiniciar aplicação

```bash
# ex: systemd / pm2 / docker
# com PM2 (exemplo):
pm run build
pm run start
# ou reiniciar o processo do container
```

5. Validar endpoints e health

```bash
curl -sS -H "x-request-id: test" https://your-app.example.com/api/health
curl -sS -H "Authorization: Bearer <token>" -X POST https://your-app.example.com/api/financial/integrations/worker/start -d '{"days":30}'
```

6. Iniciar backfill controlado

- Usar UI Integracoes ou CLI:

```bash
# CLI local/CI
npx tsx scripts/trigger-backfill.ts 30 50
```

- Monitorar `integration.worker_sync_jobs` e `integration.sync_events` durante execução.

7. Pós-validação

- Verificar `mirror.raw_payloads` incremento e `FinancialTransaction` reflexo
- Quando tudo OK, comunicar liberação e desativar `DISABLE_SHOPIFY_WEBHOOKS` se necessário

Rollback
- Restaurar backup DB se migração causar problemas

Notas
- Decisão de manter `worker_sync_jobs` em CORE para reduzir acoplamento com OMS.
- Se for necessário consolidar no OMS futuramente, planejar migração e permissões.
