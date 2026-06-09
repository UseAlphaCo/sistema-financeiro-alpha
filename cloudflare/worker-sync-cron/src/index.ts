export interface Env {
  APP_BASE_URL: string;
  CRON_SECRET: string;
  WORKER_CRON_DAYS?: string;
}

function parseDays(value: string | undefined): "30" | "60" | "90" {
  if (value === "30" || value === "60" || value === "90") {
    return value;
  }

  return "30";
}

const worker = {
  async scheduled(_controller: unknown, env: Env): Promise<void> {
    const days = parseDays(env.WORKER_CRON_DAYS);
    const requestId = `cf-cron-${Date.now()}`;
    const baseUrl = env.APP_BASE_URL.replace(/\/$/, "");
    const url = `${baseUrl}/api/internal/cron/worker-sync?days=${days}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        "x-request-id": requestId,
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Worker sync trigger failed (${response.status}): ${body}`);
    }
  },
};

export default worker;
