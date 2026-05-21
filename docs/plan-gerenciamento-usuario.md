# Plano de Gerenciamento de Usuarios

Data: 2026-05-20
Status: Planejado

## Objetivo
Implementar um sistema de gerenciamento de usuarios com autenticacao por e-mail e senha, substituindo Supabase Auth por NextAuth.js (Auth.js v5), com controle de acesso por role e operacao administrativa centralizada.

## Escopo
- Login com e-mail e senha (credentials provider).
- Gestao de usuarios somente para admin:
  - Listar usuarios.
  - Convidar usuario com role pre-definida.
  - Editar role.
  - Desativar/reativar acesso.
- Roles ativas no financeiro: admin e financeiro.
- Provisionamento inicial de 2 admins:
  - sendylago@usealphaco.com.br
  - matheus@usealphaco.com.br
  - senha padrao: noob00

## Fora de Escopo
- Self-registration publico.
- Fluxo publico de forgot password.
- Convite por SMTP (nesta fase).
- Oferta de roles operador/parceiro/influenciador no convite.

## Arquitetura Alvo
- Provedor de autenticacao: NextAuth.js (Auth.js v5).
- Persistencia de usuarios: Postgres via Prisma.
- Senha: hash com bcryptjs.
- Sessao: cookie httpOnly gerenciado pelo NextAuth.
- Autorizacao: role-based (admin, financeiro) no middleware e em API.

## Modelo de Dados (Prisma)
Criar model User com os campos:
- id
- email (unique)
- passwordHash
- role (admin | financeiro)
- status (active | disabled)
- forcePasswordChange (boolean)
- createdAt
- updatedAt

## Fases de Implementacao

### Fase 1 - Dados e Seed
1. Adicionar model User no prisma/schema.prisma.
2. Criar migration.
3. Atualizar prisma/seed.ts com os dois admins iniciais (hash de noob00).

### Fase 2 - Core de Autenticacao (NextAuth)
1. Instalar dependencias: next-auth@beta, bcryptjs, @types/bcryptjs.
2. Criar src/core/auth/auth.config.ts com CredentialsProvider.
3. Criar src/core/auth/auth.ts exportando handlers, auth, signIn, signOut.
4. Criar src/app/api/auth/[...nextauth]/route.ts.
5. Atualizar src/core/auth/session.ts para ler sessao via auth().

### Fase 3 - Middleware e Limpeza do Supabase Auth
1. Reescrever middleware.ts para usar NextAuth e manter role-check.
2. Remover dependencias de Supabase Auth:
   - src/core/auth/supabase-server.ts
   - src/core/auth/supabase-client.ts
   - src/app/api/auth/callback/route.ts
3. Atualizar src/app/api/auth/logout/route.ts para signOut do NextAuth.
4. Adicionar NEXTAUTH_SECRET nas variaveis de ambiente.

### Fase 4 - Login e Layout
1. Reescrever src/app/login/page.tsx com signIn("credentials").
2. Atualizar src/app/financeiro/layout.tsx para auth() server-side.
3. Atualizar src/app/financeiro/page.tsx para auth() server-side.

### Fase 5 - Feature de Usuarios (Admin)
1. Criar src/features/users/types.ts.
2. Criar src/features/users/repository.ts (CRUD administrativo controlado).
3. Criar src/features/users/actions.ts com guard de admin.
4. Criar APIs:
   - src/app/api/financial/users/route.ts (GET/POST)
   - src/app/api/financial/users/[id]/route.ts (PATCH)

### Fase 6 - UI de Gerenciamento
1. Criar src/app/financeiro/usuarios/page.tsx.
2. Exibir lista com email, role, status e criadoEm.
3. Formulario para convite (email + role).
4. Exibir senha temporaria apos criacao (uma unica vez na tela).
5. Acoes de alterar role e desativar/reativar.
6. Exibir link Usuarios apenas para admin.

### Fase 7 - Troca Obrigatoria de Senha
1. Implementar regra de forcePasswordChange no middleware.
2. Criar src/app/financeiro/alterar-senha/page.tsx.
3. Ao salvar nova senha: atualizar hash e forcePasswordChange=false.

## Regras de Seguranca
- Apenas admin acessa gerenciamento de usuarios.
- Usuario disabled nao autentica.
- Mensagens de erro de login devem ser genericas.
- Logs sem exposicao de senha/sigilos.
- RequestId e envelope padrao nas APIs financeiras.

## Variaveis de Ambiente
- NEXTAUTH_SECRET (novo)
- DATABASE_URL
- DIRECT_URL

## Validacao
1. npm run check sem erros.
2. Login com admin inicial funciona.
3. Login invalido retorna erro generico.
4. Admin cria usuario e recebe senha temporaria na tela.
5. Admin altera role e status.
6. Usuario disabled nao loga.
7. Role financeiro nao acessa /financeiro/usuarios.
8. Logout invalida sessao.
9. forcePasswordChange redireciona para /financeiro/alterar-senha.

## Riscos e Mitigacoes
- Risco: regressao no fluxo atual por troca de provider.
  - Mitigacao: migracao em branch dedicada + validacao completa.
- Risco: seed com senha padrao em ambiente indevido.
  - Mitigacao: executar seed apenas em ambiente controlado e trocar senha apos primeiro acesso.
- Risco: inconsistencias de role entre sessao e banco.
  - Mitigacao: role validada no middleware e nas actions/apis com guard de admin.

## Ordem Recomendada de Execucao
1. Fase 1
2. Fase 2
3. Fase 3
4. Fase 4
5. Fase 5
6. Fase 6
7. Fase 7
