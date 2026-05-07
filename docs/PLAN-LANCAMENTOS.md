
# Plano de Melhoria: Lançamentos com Categorias e Gráficos (Refinado)

## Objetivo
Adicionar suporte a categorias para Entradas e Saídas nos lançamentos financeiros, com cadastro de categorias separado em sub-menu próprio, categorias iniciais cadastradas em ordem alfabética, e layout de lançamentos em duas colunas (Novo lançamento e Gráficos).

## Status de Execução (07/05/2026)
- [x] Etapa 1 (Modelagem): estrutura já existente no schema (`TransactionCategory` e `categoryId` em `FinancialTransaction`) reaproveitada
- [x] Etapa 2 (Backend/API): CRUD de categorias implementado com `withApiSecurity`, validações e regras de negócio
- [x] Etapa 2 (Transações): categoria obrigatória para entrada/saída, validação de direção e filtro por categoria
- [x] Etapa 3 (Frontend/UX): tela de Lançamentos com CRUD de categorias, seleção obrigatória, filtro e listagem por categoria
- [x] Etapa 3 (Gráficos): gráficos de pizza e barras por categoria implementados
- [x] Etapa 5 (Testes automáticos): suíte `src/features/transactions/actions.test.ts` criada e validada
- [x] Validação técnica final: `npm run test`, `npm run typecheck`, `npm run lint` sem erros

---


## Escopo Refinado
- Cadastro de categorias separado em sub-menu "Categorias" dentro de "Lançamentos"
- Página de lançamentos não inclui CRUD de categorias (apenas seleção)
- Cadastro automático de categorias iniciais em ordem alfabética
- Listagem de categorias sempre ordenada alfabeticamente
- Layout da página de lançamentos em duas colunas: Novo lançamento e Gráficos
- Permitir CRUD completo de categorias (criar, editar, remover, listar)
- Associar lançamentos a categorias
- Permitir filtro e agrupamento por categoria
- Exibir gráficos (pizza/barras) sumarizando valores por categoria

---




## Correções Adicionais (07/05/2026)

### 6. Normalização visual da página de Categorias
- Aplicar o mesmo padrão visual da página de lançamentos: fundo branco, bordas, espaçamento, títulos, tabelas e formulários.
- Usar grid de 2 colunas em telas médias/grandes, com formulário de categoria à esquerda e listagem à direita.
- Títulos, botões e feedbacks no mesmo padrão de cores e espaçamento.
- Garantir responsividade e visual limpo.

### 7. Usabilidade do submenu "Categorias"
- Tornar o submenu acessível ao passar o mouse devagar ou ao focar com teclado.
- Manter o submenu aberto ao mover o mouse entre "Lançamentos" e "Categorias" (usando delay ou evento onMouseEnter/onMouseLeave).
- Alternativa: transformar o submenu em um dropdown clicável (abre ao clicar, fecha ao clicar fora).

### 1. Navegação e Sub-menu
- Adicionar sub-menu "Categorias" dentro de "Lançamentos" na navegação
- CRUD de categorias acessível apenas via sub-menu

### 2. Página de Lançamentos
- Remover qualquer componente de cadastro/edição de categorias
- Manter apenas seleção de categoria no formulário de novo lançamento
- Garantir layout em 2 colunas: (1) Novo lançamento, (2) Gráficos

### 3. Página de Categorias
- Página dedicada para CRUD de categorias, acessível pelo sub-menu
- Listagem de categorias sempre em ordem alfabética
- Cadastro automático (seed) das seguintes categorias iniciais:
  - Aluguel
  - Energia
  - Fornecedores
  - Impostos
  - Internet
  - Marketing
  - Pró-labore
  - Salários
  - Serviços
  - Software
  - Taxas bancárias
  - Transferências
  - Transporte
  - Vendas

### 4. Backend/API
- Garantir ordenação alfabética na listagem de categorias
- CRUD de categorias, validações e regras de negócio mantidas

### 5. Testes e Documentação
- Testes automáticos e manuais para navegação, ordenação, seed e layout
- Atualizar documentação e exemplos de tela/fluxo

---

## Critérios de Aceite Detalhados
1. Sub-menu "Categorias" disponível em "Lançamentos"
2. Página de lançamentos não permite cadastro/edição de categorias
3. Página de categorias lista e permite CRUD, sempre em ordem alfabética
4. Seed/migration insere categorias iniciais corretamente
5. Layout de lançamentos mantém 2 colunas (Novo lançamento e Gráficos)
6. Testes automáticos e manuais cobrindo navegação, ordenação, seed e layout
7. Documentação atualizada

---

## Arquivos Relevantes
- prisma/schema.prisma — modelagem e relação
- src/features/transactions/types.ts — tipos
- src/features/transactions/validations.ts — validações de filtros e payload
- src/features/transactions/repository.ts — queries e filtro por categoria
- src/features/transactions/actions.ts — regras de negócio de categoria
- src/features/transactions/actions.test.ts — testes das regras de categoria
- src/features/categories/ — CRUD e validações de categorias
- src/app/api/financial/categories/route.ts — listagem/criação de categorias
- src/app/api/financial/categories/[id]/route.ts — leitura/edição/remoção de categorias
- src/app/financeiro/lancamentos/page.tsx — entrada da página
- src/app/financeiro/lancamentos/LancamentosContent.tsx — UI de lançamentos, categorias e gráficos
- vitest.config.ts — alias `@` para testes
- src/shared/api/envelope.ts, src/types/api.ts — contratos
- docs/feature-imports.md — documentação

---

## Critérios de Aceite
1. Migration e seed aplicados
2. CRUD de categorias funcional
3. Lançamento pode ser criado/editado com categoria
4. Listagem mostra/filtro por categoria
5. Gráficos exibem quantitativos por categoria
6. Testes automáticos e manuais
7. Documentação atualizada

---

## Decisões
- Cadastro de categorias separado da tela de lançamentos
- Categorias iniciais fixas, ordem alfabética garantida
- Layout de lançamentos sempre em 2 colunas

---

## Considerações Finais
- UI de categorias será página dedicada acessada pelo sub-menu
- Flexibilidade para novas categorias e fácil manutenção
- Experiência do usuário mais clara e organizada
