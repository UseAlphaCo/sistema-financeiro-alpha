# Sistema Financeiro - Charter Operacional

## Idioma
- Respostas, comentarios e documentacao em portugues (pt-BR).
- Nomes de simbolos e arquivos seguem convencao tecnica em ingles.

## Regras de commit
- Mensagens de commit (titulo e descricao) devem ser escritas em portugues do Brasil (pt-BR).
- Nomes tecnicos (escopos, arquivos, tipos e identificadores) podem permanecer em ingles quando necessario.

## Objetivo
Construir um sistema financeiro com foco em:
- fluxo de caixa
- previsao de entrada liquida por marketplace
- reconciliacao e rastreabilidade de dados

## Regras de arquitetura
- Estrutura em camadas: core, features, shared, types.
- shared nao pode importar core nem features.
- core nao pode importar features.
- API deve usar envelope padrao: success, data, error, requestId, meta.

## Regras de seguranca
- Rotas em /api/financial/* exigem autenticacao.
- Autorizacao por role: admin e financeiro.
- Toda requisicao sensivel deve ter requestId.
- Logs devem aplicar redacao de campos sensiveis.

## Contratos tecnicos obrigatorios
- ActionResult<T>
- ApiEnvelope<T>
- AppError
- withApiSecurity

## Criticidade de dados
- Datas de periodo devem usar dias completos de calendario.
- Operacoes de importacao devem ser idempotentes por hash/lote.
- Eventos de webhook devem ser idempotentes por eventId.

## Fluxo de trabalho recomendado
1. Ler docs/PLAN-IMPLEMENTACAO.md
2. Implementar conforme ordem de sprints
3. Executar check local: lint, typecheck, boundaries, contracts, test, build
4. Atualizar docs de feature ao alterar comportamento

