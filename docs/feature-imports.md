# Documentação: Importação e Categorias

## Categorias em Lançamentos

- Cadastro de categorias separado, acessível via sub-menu "Categorias" em Lançamentos.
- Página de lançamentos não permite CRUD de categorias, apenas seleção.
- Categorias iniciais cadastradas automaticamente em ordem alfabética.
- Listagem de categorias sempre ordenada alfabeticamente.
- Layout da página de lançamentos em 2 colunas: Novo lançamento e Gráficos.
- CRUD completo de categorias disponível na página dedicada.

## Exemplos de Payload

### Criação de Categoria
```json
{
  "name": "Vendas",
  "direction": "entrada",
  "color": "#0f766e"
}
```

### Criação de Lançamento
```json
{
  "type": "income",
  "categoryId": "...",
  "amountCents": 100000,
  "occurredAt": "2026-05-07T12:00:00.000Z",
  "description": "Venda de produto",
  "source": "manual",
  "status": "approved"
}
```

## Fluxo do Usuário
1. Acessa "Lançamentos" > "Categorias" para gerenciar categorias.
2. Utiliza a página de lançamentos para registrar movimentações, selecionando a categoria desejada.
3. Visualiza gráficos e quantitativos por categoria na própria tela de lançamentos.

## Testes
- Testes automáticos cobrem regras de negócio, validações e integração.
- Testes manuais validam fluxo completo, edge cases e experiência do usuário.
