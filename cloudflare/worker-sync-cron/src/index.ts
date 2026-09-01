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
 *
 * D-1 roda de MANHA (06:30 BRT), e nao junto dos outros as 23 h. O passe D-0
 * das 23 h le um dia que ainda esta acontecendo: o mirror e alimentado por um
 * sync de 3 em 3 horas, entao as ultimas horas do dia ainda nao chegaram.
 * Medido em 25/08/2026: 1.365 dos 1.738 pedidos Shopify do dia, 78,5% -- as
 * telas mostravam R$ 207.402,93 contra R$ 264.683,09 reais. Com D-1 as 23:15,
 * a correcao so chegava na noite SEGUINTE, ou seja o dia inteiro em que aquela
 * data e "Ontem" era exibido incompleto.
 *
 * As 06:30 os syncs de 03:00 e 06:00 ja rodaram e o dia anterior esta fechado
 * ha mais de 6 h. Mesma quantidade de invocacoes: e troca de horario, nao
 * aumento de cadencia -- nao custa nada na cota de Fluid Active CPU.
 *
 * D-1 roda DUAS vezes: 06:30 e 11:05 BRT. As 06:30 nao basta porque pedido
 * ainda e pago depois disso. Medido em 30/08/2026: o passe das 06:30 rodou
 * 09:31:27Z e 6 pedidos Appmax so receberam `orders/paid` no mirror entre
 * 10:18Z e 10:34Z -- ainda estavam `pending` quando o passe olhou, e R$ 778,25
 * ficaram de fora justamente enquanto aquela data era "Ontem" na tela. O passe
 * D-2 curava, mas so na noite seguinte.
 *
 * 11:05 BRT porque e quando os relatorios da Shopify fecham a contagem de
 * "ontem": e a ultima palavra dos dois lados no mesmo momento. Os 5 min de
 * folga sao para cair depois da resolucao de gateway das 11:00 BRT, nao junto.
 *
 * Ressalva: o sync OMS->mirror mais recente nesse horario e o das 09:00 BRT
 * (cadencia de 3 em 3 h). Quem for pago entre 09:00 e 11:05 so entra no passe
 * D-2. Fechar essa fresta exigiria sync mais frequente, que e orcamento de CPU.
 */
const MATERIALIZE_CRONS: Record<string, number> = {
  "0 2 * * *": 0,
  "30 9 * * *": -1,
  "5 14 * * *": -1,
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
