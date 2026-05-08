# Plano de Melhoria do CI Quality

## Objetivo
Eliminar falhas recorrentes do job `quality` no CI, reduzir diferencas entre execucao local e remota e melhorar o diagnostico quando houver erro.

## Contexto do problema
- O CI falha com `Process completed with exit code 1`.
- A causa raiz mais provavel e violacao de boundaries: arquivo em `core` importando modulo de `features`.
- Exemplo identificado: `src/core/cache/dailySnapshot.ts` importando `@/features/transactions/types`.

## Escopo
- Corrigir violacao arquitetural (bloqueante).
- Endurecer workflow do CI para consistencia.
- Melhorar observabilidade dos erros no pipeline.
- Criar guardrails para evitar regressao em novos commits.

## Fora de escopo
- Refatoracoes amplas de dominio sem relacao com o gate `quality`.
- Reestruturacao completa de todos os workflows alem do `ci.yml` atual.

## Plano de execucao

### Fase 1 - Reproducao fiel local
1. Executar ambiente limpo:
   - `rm -rf node_modules .next`
   - `npm ci`
2. Executar pipeline completo local:
   - `npm run lint`
   - `npm run typecheck`
   - `npm run check:boundaries`
   - `npm run check:contracts`
   - `npm run test`
   - `npm run build`
3. Registrar em qual etapa ocorre falha.

Criterio de saida:
- Falha reproduzida no mesmo ponto do CI, com evidencia objetiva.

### Fase 2 - Correcao da causa raiz (bloqueante)
1. Remover import proibido de `features` dentro de `core`.
2. Mover tipagem para camada permitida (`types` ou `shared`) ou tornar API agnostica de dominio.
3. Revalidar `check:boundaries` isoladamente.

Criterio de saida:
- `npm run check:boundaries` concluindo com sucesso.

### Fase 3 - Hardening do workflow CI
1. Atualizar setup de Node no workflow para versao suportada e pin de versao.
2. Definir `NODE_ENV=production` explicitamente no job `quality`.
3. Garantir ordem de gates alinhada ao fluxo local (`lint -> typecheck -> boundaries -> contracts -> test -> build`).

Criterio de saida:
- Workflow consistente, deterministico e sem variacao por ambiente.

### Fase 4 - Observabilidade de falhas
1. Publicar artefatos de log quando houver falha.
2. Melhorar mensagens de erro de scripts de gate com arquivo/regra violada.
3. Padronizar resumo de falha para acelerar triagem.

Criterio de saida:
- Qualquer falha nova deve ser rastreavel sem adivinhacao.

### Fase 5 - Guardrails para equipe
1. Documentar no README o checklist obrigatorio antes de push.
2. Padronizar uso de `npm run check` antes de commit/push.
3. Avaliar hook de pre-push (opcional no inicio, obrigatorio apos estabilizacao).

Criterio de saida:
- Menor reincidencia de falha no CI por erro evitavel localmente.

### Fase 6 - Validacao final
1. Rodar pipeline completo local em ambiente limpo.
2. Fazer push de validacao.
3. Confirmar job `quality` verde no CI.

Criterio de saida:
- CI aprovado sem `exit code 1`.

## Riscos e mitigacoes
- Risco: correcao de boundary quebrar contrato de tipos.
  - Mitigacao: rodar `typecheck`, `check:contracts` e testes apos cada ajuste.
- Risco: divergencia de versao Node local vs CI.
  - Mitigacao: pin de versao no workflow e alinhamento no time.
- Risco: falhas intermitentes sem contexto.
  - Mitigacao: upload de artefatos e logs padronizados.

## Checklists operacionais

### Checklist de pre-push
- [ ] `npm ci`
- [ ] `npm run check`
- [ ] `npm run build`

### Checklist de encerramento
- [ ] Boundary violation removida
- [ ] Workflow CI atualizado
- [ ] README atualizado
- [ ] Push de validacao com `quality` aprovado

## Evidencias esperadas
- Saida dos comandos locais.
- Link do run de CI aprovado.
- Diff dos arquivos de configuracao alterados (`ci.yml`, `README`, arquivos de dominio impactados).
