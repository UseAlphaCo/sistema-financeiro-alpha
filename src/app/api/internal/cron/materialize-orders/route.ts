import type { NextRequest } from "next/server";

import { runMaterializeOrdersJob } from "@/features/transactions/materialize-orders-job";
import { createApiError, createApiSuccess } from "@/shared/api/envelope";

export const runtime = "nodejs";

/**
 * Sem isto vale o default curto da plataforma e um dia cortado no meio some
 * sem registro -- mesmo motivo ja documentado em worker-sync/route.ts.
 *
 * Dimensionado para UM dia por invocacao, e e por isso que o cron dispara tres
 * horarios (D-0, D-1, D-2) em vez de uma chamada com os tres dias: a folga de
 * +-2 dias faz cada dia varrer uma janela de 5 dias, medido em 32.266 chaves
 * candidatas = 65 lotes de KEY_CHUNK. Tres dias numa chamada nao cabem aqui.
 */
export const maxDuration = 300;

/**
 * Materializacao diaria de pedidos.
 *
 * ATENCAO: com MAINTENANCE_MODE="true" esta rota devolve 503 antes do handler
 * -- /api/internal esta em FROZEN_API_PREFIXES (src/proxy.ts), justamente
 * porque as rotas de cron abrem pools contra o CORE. Desde 25/08/2026 o freeze
 * e opt-in, entao no caminho normal a rota responde. Para rodar fora do cron,
 * use `npx tsx scripts/materialize-orders-window.ts`.
 *
 * Copia estrutural de shopify-payment-resolution/route.ts: runtime nodejs, auth
 * por CRON_SECRET e envelope padrao.
 */

const MAX_DAYS = 45;

/**
 * Dias explicitos, para reprocessar janela historica sem esperar o cron.
 *
 * Valida o formato aqui e nao no job: dia mal formado viraria `Invalid Date`, e
 * uma janela NaN devolveria zero candidatos SEM ERRO -- o job registraria
 * "sucesso, nada a fazer" para um dia que nunca foi processado.
 */
function parseDays(value: string | null): string[] | undefined {
  if (!value) return undefined;

  const days = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (days.length === 0) return undefined;
  if (days.length > MAX_DAYS) {
    throw new Error(`no maximo ${MAX_DAYS} dias por chamada (pedidos: ${days.length})`);
  }

  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      throw new Error(`dia invalido: ${day} (esperado YYYY-MM-DD)`);
    }
    if (Number.isNaN(new Date(`${day}T00:00:00-03:00`).getTime())) {
      throw new Error(`dia inexistente no calendario: ${day}`);
    }
  }

  return days;
}

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  const bearer = request.headers.get("authorization");
  if (bearer === `Bearer ${expected}`) return true;

  const direct = request.headers.get("x-cron-secret");
  return direct === expected;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!isAuthorized(request)) {
    return createApiError(requestId, "Nao autorizado.", 401);
  }

  try {
    const days = parseDays(request.nextUrl.searchParams.get("days"));
    const summary = await runMaterializeOrdersJob({ days });
    return createApiSuccess(requestId, summary);
  } catch (error) {
    return createApiError(
      requestId,
      error instanceof Error ? error.message : "Falha ao materializar pedidos.",
      500
    );
  }
}
