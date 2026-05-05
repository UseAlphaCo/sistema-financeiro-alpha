# Architecture Overview

## Stack
- Next.js App Router
- TypeScript strict
- Tailwind
- Camada de seguranca por middleware + wrapper de API

## Camadas
- src/core: autenticacao, seguranca, observabilidade, contratos de erro
- src/features: modulos de dominio financeiro
- src/shared: utilitarios e contratos compartilhados
- src/types: tipos transversais

## Regras de dependencia
- shared nao importa core nem features
- core nao importa features
- features podem importar core, shared e types

## Contratos
- ApiEnvelope<T>
- ActionResult<T>
- AppError
- withApiSecurity

## Seguranca
- Middleware para rotas protegidas
- withApiSecurity para auth, role, rate limit e requestId
- Redacao de dados sensiveis nos logs
