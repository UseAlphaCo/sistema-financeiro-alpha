# Feature: Imports

## Objetivo
Permitir importacao de transacoes e taxas com validacao, preview e rollback por lote.

## Fluxo
1. Upload do arquivo
2. Preview com mapeamento
3. Validacao de schema
4. Persistencia por lote
5. Rollback se necessario

## Garantias
- Dedupe por hash
- Rastreio por import batch
- Erros por linha com motivo explicito
