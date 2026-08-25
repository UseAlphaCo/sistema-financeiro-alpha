export interface Env {
  APP_BASE_URL: string;
  CRON_SECRET: string;
  WORKER_CRON_DAYS?: string;
  SHOPIFY_RESOLUTION_BATCH_SIZE?: string;
  SHOPIFY_RESOLUTION_SINCE_DAYS?: string;
}

/**
 * As expressoes aqui sao a CHAVE do switch, entao precisam ser identicas as de
 * wrangler.jsonc caractere a caractere. Divergir nao quebra o deploy: o cron
 * dispara e cai no `default`, que so lanca erro nos logs do Cloudflare.
 */
const WORKER_SYNC_CRON = "0 */3 * * *";
const SHOPIFY_RESOLUTION_CRON = "0 */2 * * *";
const SHOPIFY_VERIFY_CRON = "0 9 * * *";

/**
 * Materializacao diaria, um dia por invocacao.
 *
 * Tres horarios em vez de uma chamada com os tres dias porque cada dia varre
 * uma janela de 5 dias de chaves (folga de +-2) e nao caberia no maxDuration
 * de 300 s da rota. Separado tambem isola a falha: se D-2 estourar, D-0 ja
 * terminou.
 */
const MATERIALIZE_CRONS: Record<string, number> = {
  "0 2 * * *": 0,
  "15 2 * * *": -1,
  "30 2 * * *": -2,
};

/** Dia de calendario em America/Sao_Paulo. Espelha saoPauloDay do CORE. */
function saoPauloDay(offsetDays: number): string {
  const shifted = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
}

function parseDays(value: string | undefined): "30" | "60" | "90" {
  if (value === "30" || value === "60" || value === "90") {
    return value;
  }

  return "30";
}

async function callInternalCron(env: Env, path: string, requestId: string): Promise<void> {
  const baseUrl = env.APP_BASE_URL.replace(/\/$/, "");
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${env.CRON_SECRET}`,
      "x-request-id": requestId,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Cron trigger failed for ${path} (${response.status}): ${body}`);
  }
}

const worker = {
  async scheduled(controller: { cron: string }, env: Env): Promise<void> {
    const requestId = `cf-cron-${Date.now()}`;

    const materializeOffset = MATERIALIZE_CRONS[controller.cron];
    if (materializeOffset !== undefined) {
      const day = saoPauloDay(materializeOffset);
      await callInternalCron(env, `/api/internal/cron/materialize-orders?days=${day}`, requestId);
      return;
    }

    switch (controller.cron) {
      case WORKER_SYNC_CRON: {
        const days = parseDays(env.WORKER_CRON_DAYS);
        await callInternalCron(env, `/api/internal/cron/worker-sync?days=${days}`, requestId);
        return;
      }
      case SHOPIFY_RESOLUTION_CRON: {
        const batchSize = env.SHOPIFY_RESOLUTION_BATCH_SIZE ?? "150";
        const sinceDays = env.SHOPIFY_RESOLUTION_SINCE_DAYS ?? "3";
        await callInternalCron(
          env,
          `/api/internal/cron/shopify-payment-resolution?batchSize=${batchSize}&sinceDays=${sinceDays}`,
          requestId
        );
        return;
      }
      case SHOPIFY_VERIFY_CRON: {
        await callInternalCron(env, `/api/internal/cron/shopify-verify`, requestId);
        return;
      }
      default:
        throw new Error(`Cron desconhecido: ${controller.cron}`);
    }
  },
};

export default worker;
