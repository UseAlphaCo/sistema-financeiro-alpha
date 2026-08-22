/**
 * Configuracao unica para decidir se o read model deve ler o mirror do CORE
 * (mirror.raw_payloads) em vez da tabela legada FinancialTransaction.
 *
 * Antes desta unificacao, existiam 2 condicoes divergentes no codebase:
 * - dependente de NODE_ENV === "production" (quebrava em dev local mesmo com
 *   CORE_DB_URL configurado).
 * - dependente apenas de Boolean(CORE_DB_URL) (nao tratava string vazia).
 *
 * Regra unica: mirror fica ligado sempre que houver uma connection string
 * valida (nao vazia) para o CORE, a menos que FINANCIAL_READ_MODEL_MIRROR
 * esteja explicitamente como "false".
 */

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getCoreConnectionString(): string | undefined {
  return nonEmpty(process.env.CORE_DB_URL) ?? nonEmpty(process.env.DATABASE_URL);
}

export function isMirrorReadModelEnabled(): boolean {
  const hasCoreConnection = Boolean(getCoreConnectionString());
  const mirrorFlag = process.env.FINANCIAL_READ_MODEL_MIRROR;

  return hasCoreConnection && mirrorFlag !== "false";
}

/**
 * Le pela tabela materializada (integration.financial_orders) em vez de varrer
 * o mirror a cada request.
 *
 * Default DESLIGADO, ao contrario de isMirrorReadModelEnabled: enquanto os dois
 * caminhos coexistem, ligar por omissao trocaria a fonte de verdade das telas
 * sem ninguem decidir isso. `=== "true"` e nao `!== "false"` de proposito.
 */
export function isMaterializedReadModelEnabled(): boolean {
  return (
    Boolean(getCoreConnectionString()) &&
    process.env.FINANCIAL_READ_MODEL_MATERIALIZED === "true"
  );
}

/**
 * Data a partir da qual existe dado. Antes disto as telas nao tem o que mostrar.
 *
 * Nao e preferencia de produto: em 2026-08-21 o mirror foi truncado de proposito
 * e as 604.418 linhas de 26/04 a 31/07 sairam. A tabela legada
 * FinancialTransaction tem zero linhas, entao para qualquer periodo anterior ao
 * piso as duas fontes devolvem vazio -- e vazio na tela le-se como "nao vendeu
 * nada", nao como "nao temos esse dado". E essa confusao que o piso existe para
 * impedir.
 *
 * Mesmo valor e mesmo nome de variavel do piso do sync
 * (SYNC_MIRROR_FLOOR_AT em src/workers/sync/config.ts): dois pisos diferentes
 * fariam a tela prometer uma janela que o sync nao mantem.
 *
 * Devolve null se a variavel estiver com valor invalido -- e "sem piso
 * conhecido", que a camada de cobertura trata como "nao anotar nada", em vez de
 * um NaN que faria toda comparacao de data ser falsa em silencio.
 */
export function getMaterializedFloorDate(): Date | null {
  const raw = nonEmpty(process.env.SYNC_MIRROR_FLOOR_AT) ?? "2026-08-01T00:00:00-03:00";
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
