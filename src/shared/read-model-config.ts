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
