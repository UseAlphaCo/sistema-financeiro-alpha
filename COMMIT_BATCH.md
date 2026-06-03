Branch: deploy/alp-core-cutover-20260603

Objetivo: preparar commits e instruções para novo deploy na Vercel que ativa ALP-CORE-FIN como banco principal, aplica seed e dispara backfill.

Instruções rápidas

1. Criar branch local:

```bash
git checkout -b deploy/alp-core-cutover-20260603
```

2. Commit 1 — adicionar script de migração users

Title:
chore(migration): add script to copy users from PESSOAL_DIRECT_URL to CORE_DB_URL

Description:
Add `scripts/copy-users-from-pessoal-to-core.ts`, an idempotent script that upserts users by email from the personal database into the ALP-CORE-FIN database. This enables migrating existing user accounts into the core database prior to switching production traffic.

Git commands:

```bash
git add scripts/copy-users-from-pessoal-to-core.ts
git commit -m "chore(migration): add script to copy users from PESSOAL_DIRECT_URL to CORE_DB_URL" -m "Add scripts/copy-users-from-pessoal-to-core.ts — idempotent upsert by email to migrate user accounts from PESSOAL to CORE. Tested locally: migrated 6 users."
```

3. Commit 2 — document cutover and deploy steps

Title:
docs(ops): add deploy/cutover instructions for ALP-CORE-FIN

Description:
Add `COMMIT_BATCH.md` with step-by-step instructions to perform the cutover: seed ALP-CORE-FIN, run migration script, trigger backfill, and validate UI/SSR. Include recommended Vercel commands and verification queries.

Git commands:

```bash
git add COMMIT_BATCH.md
git commit -m "docs(ops): add deploy/cutover instructions for ALP-CORE-FIN" -m "Document steps to seed CORE, migrate users, trigger backfill and validate deployment. Intended as runbook for safe cutover and Vercel deploy."
```

4. Commit 3 — optional: remove unused env keys (DO NOT commit secrets)

Title:
chore(env): document removal of PESSOAL_DIRECT_URL (DO NOT commit .env)

Description:
Document in the deploy notes that `PESSOAL_DIRECT_URL` was removed from local `.env`. DO NOT commit `.env` or any secrets — update Vercel Project Environment variables instead.

Git commands (only updates docs, not .env):

```bash
echo "PESSOAL_DIRECT_URL removed from local .env; update Vercel envs manually" >> COMMIT_BATCH.md
git add COMMIT_BATCH.md
git commit -m "chore(env): document removal of PESSOAL_DIRECT_URL (DO NOT commit .env)" -m "Advise updating Vercel environment variables and not committing sensitive .env files to repository." 
```

5. Push & create PR (optional)

```bash
git push -u origin deploy/alp-core-cutover-20260603
# create PR on Git provider and request review from @matheus and @sendylago
```

6. Deploy on Vercel

- From PR: Vercel will create a preview deployment. Verify preview app and run the following (or use Vercel CLI):

```bash
# promote preview to production via Vercel UI or CLI (if using Vercel CLI):
vercel deploy --prod
```

7. Post-deploy runbook (manual)

- Execute seed on CORE (if not already):

```bash
set -a; source .env; set +a
DATABASE_URL="$CORE_DB_URL" npm run prisma:seed
```

- Trigger backfill (existing script):

```bash
set -a; source .env; set +a
npx tsx scripts/trigger-backfill.ts 30 50
```

- Validate UI (authenticated) on `/financeiro/dashboard` and run these queries against CORE:

```sql
SELECT count(*) FROM "User";
SELECT count(*) FROM mirror.raw_payloads;
```

Notas de segurança
- Nunca commit `.env` com segredos.
- Atualize variáveis de ambiente no painel do Vercel antes de promover o deploy.

Se quiser, eu posso aplicar esses commits localmente (fazer os `git commit` e `push`) — autoriza que eu execute os comandos `git` no repositório? Caso sim, responda "autorizar git".
