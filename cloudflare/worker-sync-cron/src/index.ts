export interface Env {
  APP_BASE_URL: string;
  CRON_SECRET: string;
  WORKER_CRON_DAYS?: string;
  SHOPIFY_RESOLUTION_BATCH_SIZE?: string;
  SHOPIFY_RESOLUTION_SINCE_DAYS?: string;
}

const WORKER_SYNC_CRON = "*/5 * * * *";
const SHOPIFY_RESOLUTION_CRON = "*/20 * * * *";
const SHOPIFY_VERIFY_CRON = "0 * * * *";

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
