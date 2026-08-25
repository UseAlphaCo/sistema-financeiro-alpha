import { getPrismaClient } from "@/core/db/prisma-client";
import { logError } from "@/core/observability/logger";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

/**
 * Tira usuario:senha de qualquer connection string embutida na mensagem.
 *
 * Erro de conexao do Prisma costuma citar a URL inteira, e esta rota e publica
 * -- o log dela vai parar em qualquer coletor. O redator do logger so limpa por
 * NOME de campo, entao nao alcanca credencial no meio de um texto livre.
 */
function semCredenciais(texto: string): string {
  return texto.replace(/\/\/[^@\s]+@/g, "//[REDACTED]@");
}

export async function GET() {
  const requestId = crypto.randomUUID();

  try {
    const db = getPrismaClient();
    await db.$queryRaw`SELECT 1`;
  } catch (error) {
    // Sem isto o motivo real morre no catch e "db: down" fica indistinguivel
    // entre credencial errada, rede bloqueada e falha do proprio Prisma -- foi
    // exatamente o que travou o diagnostico do freeze em 25/08/2026.
    logError("health_db_down", {
      requestId,
      erro: semCredenciais(error instanceof Error ? error.message : String(error)),
      tipo: error instanceof Error ? error.name : typeof error,
    });

    return createApiError(
      requestId,
      "Banco de dados indisponivel.",
      503,
      { service: "sistema-financeiro", version: "0.1.0", db: "down" }
    );
  }

  return createApiSuccess(requestId, {
    status: "ok",
    service: "sistema-financeiro",
    version: "0.1.0",
    db: "up",
  });
}
