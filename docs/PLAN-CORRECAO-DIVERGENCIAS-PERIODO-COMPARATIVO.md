# Plano de Correcao de Divergencias de Periodo e Comparativo no Fluxo de Caixa

## Objetivo
Corrigir inconsistencias observadas em ambiente local entre filtros de data, periodo exibido no cabecalho e calculo do comparativo vs periodo anterior, removendo o filtro visual "Periodo preset" do formulario do Fluxo de Caixa e preservando os contratos atuais.

## Contexto do problema (evidencias dos testes manuais)
- Com preset Ontem, o cabecalho em alguns cenarios mostra duracao divergente (ex.: 2 dias para janela de 1 dia).
- Com startDate=endDate, ha discrepancia entre data escolhida no formulario e periodo exibido no cabecalho/listagem.
- URL do Fluxo pode conter parametros repetidos de preset apos submit (ambiguidade de leitura da querystring).
- O comparativo vs periodo anterior depende da duracao do periodo atual; se os dias estiverem inflados, o delta fica semantica e numericamente distorcido.
- O seletor "Periodo preset" no formulario gera redundancia com os chips de periodo no topo e aumenta risco de estado inconsistente.

## Escopo incluido
- Correcao de calculo de duracao de periodo (days).
- Correcao de parse de datas customizadas em timezone local.
- Correcao da montagem de querystring para evitar preset duplicado.
- Remocao do filtro "Periodo preset" da area de formulario do Fluxo de Caixa.
- Revalidacao da coerencia do comparativo vs periodo anterior com os intervalos corrigidos.

## Escopo excluido (nesta rodada)
- Mudancas de copy/UX do texto de delta (ex.: sem base comparativa).
- Novos filtros de origem e telemetria adicional de mapeamento de pagamento.
- Alteracoes de layout fora das telas de periodo/comparativo.

---

## Fase 1 - Diagnostico tecnico fechado
### Objetivo
Consolidar causas raiz com referencia exata no codigo, garantindo que cada divergencia visual tenha um ponto objetivo de correcao.
### Comentario de execucao
- Causa raiz confirmada em 3 pontos: calculo de days com arredondamento inadequado, parse implicito de data em UTC e redundancia de preset no formulario.

## Fase 2 - Correcao de duracao do periodo
### Objetivo
Ajustar a regra que calcula days para evitar inflacao de dias em intervalos fechados do mesmo dia.
### Comentario de execucao
- Implementado em src/features/cash-flow/service.ts: formula de days trocada para base deterministica sem inflacao em intervalo de 1 dia.

## Fase 3 - Correcao de parse local para startDate/endDate
### Objetivo
Trocar parse implicito de YYYY-MM-DD por parse local explicito (ano/mes/dia), com normalizacao de inicio e fim do dia no fuso local.
### Comentario de execucao
- Implementado em src/features/cash-flow/service.ts com helper local de parse para inicio/fim do dia em timezone local.

## Fase 4 - Higienizacao da querystring no Fluxo
### Objetivo
Remover duplicidade de preset no formulario GET para evitar conflitos de interpretacao e diferencas entre refresh e navegacao.
### Comentario de execucao
- Ajuste aplicado no formulario do Fluxo para manter somente um envio de preset por submit.

## Fase 5 - Remocao do filtro visual "Periodo preset"
### Objetivo
Simplificar a UX removendo o seletor de "Periodo preset" do formulario, mantendo selecao de periodo somente pelos chips de topo e sem quebrar comportamento de filtro por data e pagamento.
### Comentario de execucao
- Seletor visual removido de src/app/financeiro/fluxo-de-caixa/page.tsx; chips de topo permanecem como controle principal de periodo.

## Fase 6 - Validacao funcional guiada pelos cenarios reportados
### Objetivo
Reexecutar cenarios dos prints e confirmar consistencia ponta a ponta entre filtro, periodo, cards e comparativo.
### Comentario de execucao
- Validacao manual concluida em ambiente local com sucesso nos cenarios A/B/C.

## Fase 7 - Verificacao tecnica final
### Objetivo
Executar validacoes automaticas essenciais apos os ajustes para assegurar ausencia de regressao de tipagem/lint.
### Comentario de execucao
- Executado com sucesso: npm run typecheck e npm run lint.

---

## Etapas detalhadas (ordem de execucao)
1. Mapear no servico de cash-flow os pontos de calculo de periodo atual e periodo anterior.
2. Ajustar calculo de days com regra deterministica para intervalos fechados.
3. Validar que periodo anterior usa exatamente a mesma quantidade de dias calculada.
4. Ajustar parse de filtros startDate/endDate para construcao local da data.
5. Confirmar que cabecalho e listagem usam a mesma janela efetiva calculada.
6. Remover campo redundante de preset no formulario do Fluxo.
7. Validar URL final apos submit sem repeticao de preset.
8. Remover seletor visual "Periodo preset" do formulario, preservando chips de periodo no topo.
9. Reexecutar cenario A: pagina sem query (preset Ontem).
10. Reexecutar cenario B: startDate=endDate com preset Ontem.
11. Reexecutar cenario C: preset 7 dias sem datas customizadas.
12. Conferir delta vs periodo anterior em Receita, Despesas e Liquido apos correcao.
13. Rodar typecheck e lint para fechamento da rodada.

## Arquivos alvo
- /Users/sendylago/Alpha/dev/sistema-financeiro/src/features/cash-flow/service.ts
Objetivo: corrigir calculo de days, parse de start/end custom e consistencia de previousPeriod.

- /Users/sendylago/Alpha/dev/sistema-financeiro/src/app/financeiro/fluxo-de-caixa/page.tsx
Objetivo: eliminar preset duplicado na query/form e manter comportamento deterministico de filtros.

- /Users/sendylago/Alpha/dev/sistema-financeiro/src/lib/date-utils.ts (opcional)
Objetivo: extrair helper de parse local reutilizavel caso a logica precise ser compartilhada.

- /Users/sendylago/Alpha/dev/sistema-financeiro/docs/PLAN-IMPLEMENTACAO-v0-2.md
Objetivo: atualizar status apos validacao, registrando correcao da divergencia de periodo.

## Criterios de aceite
1. Para intervalo de 1 dia, cabecalho exibe 1 dia (sem inflacao).
2. Com startDate=endDate, periodo exibido corresponde exatamente ao dia informado.
3. URL do Fluxo nao repete preset apos submit do formulario.
4. Filtro visual "Periodo preset" nao e exibido no formulario do Fluxo.
5. Cards e delta vs periodo anterior refletem base temporal coerente.
6. Typecheck e lint sem novos erros.

## Plano de validacao manual (roteiro objetivo)
1. Acessar /financeiro/fluxo-de-caixa sem querystring.
Resultado esperado: preset Ontem selecionado e cabecalho com 1 dia.

2. Preencher Data inicial e Data final com o mesmo dia e filtrar.
Resultado esperado: cabecalho no mesmo dia selecionado; tabela no mesmo recorte.

3. Alternar para 7 dias, 30 dias e voltar para Ontem.
Resultado esperado: cabecalho e cards atualizam sem deslocamento.

4. Comparar URL antes e depois do submit.
Resultado esperado: apenas um parametro preset.

5. Confirmar ausencia do campo visual "Periodo preset" no formulario.
Resultado esperado: periodo e controlado por chips de topo e/ou datas customizadas.

6. Validar deltas de Receita e Liquido.
Resultado esperado: numeros e sinal compativeis com o periodo anterior de mesmo tamanho.

## Riscos e mitigacao
- Risco: regressao em paginas que tambem dependem de parse de data.
Mitigacao: centralizar helper local de data em util compartilhado (se necessario).

- Risco: diferenca de comportamento por timezone do ambiente.
Mitigacao: parse local explicito + normalizacao start/end of day.

- Risco: correcao parcial do problema (UI e servico desalinhados).
Mitigacao: validacao cruzada cabecalho + cards + listagem + querystring.

## Status de execucao do plano
- Fase 1: Concluida
- Fase 2: Concluida
- Fase 3: Concluida
- Fase 4: Concluida
- Fase 5: Concluida
- Fase 6: Concluida
- Fase 7: Concluida

## Registro de execucao
- 07/05/2026 - Implementacao tecnica aplicada em:
	- src/features/cash-flow/service.ts
	- src/app/financeiro/fluxo-de-caixa/page.tsx
- 07/05/2026 - Verificacao tecnica automatica:
	- npm run typecheck: OK
	- npm run lint: OK
- 07/05/2026 - Proximo checkpoint:
	- Plano finalizado nesta rodada. Monitorar apenas eventuais ajustes finos de UX/copy fora de escopo.

- 07/05/2026 - Homologacao manual dos cenarios do bug:
	- Cenario A (sem query): URL /financeiro/fluxo-de-caixa, cabecalho 06/05/2026 — 06/05/2026 (1 dias), sem filtro visual "Periodo preset" no formulario.
	- Cenario B (startDate=endDate): URL /financeiro/fluxo-de-caixa?preset=yesterday&startDate=2026-05-06&endDate=2026-05-06&paymentMethod=, cabecalho coerente 06/05/2026 — 06/05/2026 (1 dias), sem preset duplicado na querystring.
	- Cenario C (preset 7 dias): URL /financeiro/fluxo-de-caixa?preset=d7, cabecalho coerente 01/05/2026 — 07/05/2026 (7 dias), sem deslocamento de data.

## Ritmo de atualizacao (manutencao continua)
- A cada fase concluida, atualizar este arquivo com status: Planejada -> Em execucao -> Concluida.
- Sempre registrar evidencias objetivas (comando executado, resultado observado, cenario validado).
- Em caso de mudanca de escopo, adicionar secao Decisao com motivo e impacto.

## Decisao atual
- Correcao iniciada e executada apos aprovacao explicita do usuario para executar o plano.
