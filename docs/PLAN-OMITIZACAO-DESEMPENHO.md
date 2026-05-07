# Plano de Otimização de Desempenho: Cache Diário Consolidado

## Objetivo
Acelerar drasticamente o carregamento dos dados de "Ontem" utilizando um cache diário consolidado em tabela dedicada, atualizado automaticamente após a virada do dia.

---

## 1. Modelagem da Tabela no Prisma

Adicionar ao `prisma/schema.prisma`:

```prisma
model DailySnapshot {
  date         DateTime  @id
  data         Json
  generatedAt  DateTime  @default(now())
  meta         Json?
}
```

Rodar:
- `npx prisma migrate dev --name add-daily-snapshot`

---

## 2. Repositório de Acesso ao Cache

Criar `src/core/cache/dailySnapshot.ts`:
- Funções:
  - `saveDailySnapshot(date: Date, data: any, meta?: any)`
  - `getDailySnapshot(date: Date)`
  - `invalidateDailySnapshot(date: Date)`

---

## 3. Job de Consolidação

Criar script `scripts/generate-daily-snapshot.ts`:
- Passos:
  1. Calcular data de ontem (UTC ou timezone do negócio).
  2. Executar a mesma query que alimenta o frontend para "Ontem" (buscar transações, somar, agrupar, etc).
  3. Salvar o resultado em `DailySnapshot` com a data de ontem.
  4. Logar sucesso/erro.

Agendar execução diária (exemplo cron):
```
5 0 * * * node scripts/generate-daily-snapshot.ts
```

---

## 4. Consulta Otimizada no Backend

No repositório de transações (ex: `src/features/transactions/repository.ts`):
- Ao receber filtro de data = ontem:
  - Buscar em `DailySnapshot`.
  - Se não existir, rodar consulta ao vivo e (opcional) preencher o cache.

---

## 5. Invalidação/Atualização

Ao importar/alterar/excluir transação de ontem:
- Chamar `invalidateDailySnapshot(date)` para remover o cache daquele dia.
- Opcional: regenerar imediatamente.

---

## 6. Testes e Verificação

- Rodar `npm run lint && npm run typecheck && npm run test`.
- Validar geração do snapshot manualmente (executando o script).
- Conferir leitura do cache no endpoint.
- Medir tempo de resposta antes/depois.

---

## 7. Observações

- O campo `data` pode armazenar qualquer estrutura (lista, totais, agrupamentos).
- Use sempre o mesmo timezone para garantir consistência.
- O cache pode ser expandido para outros períodos críticos (ex: semana passada).

---

## Resumo dos Passos
1. Adicionar modelo Prisma e rodar migration.
2. Implementar repositório de cache.
3. Criar script de consolidação.
4. Adaptar backend para usar o cache.
5. Testar e monitorar.
