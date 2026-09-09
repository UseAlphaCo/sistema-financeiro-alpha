export interface Env {
  APP_BASE_URL: string;
  CRON_SECRET: string;
  WORKER_CRON_DAYS?: string;
  SHOPIFY_RESOLUTION_BATCH_SIZE?: string;
  SHOPIFY_RESOLUTION_SINCE_DAYS?: string;
  SHOPIFY_PRECLOSE_BATCH_SIZE?: string;
  SHOPIFY_PRECLOSE_SINCE_DAYS?: string;
}

/**
 * As expressoes aqui sao a CHAVE do switch, entao precisam ser identicas as de
 * wrangler.jsonc caractere a caractere. Divergir nao quebra o deploy: o cron
 * dispara e cai no `default`, que so lanca erro nos logs do Cloudflare.
 *
 * A JANELA DA MANHA e' uma corrente com ordem obrigatoria, e nao quatro crons
 * independentes que por acaso rodam perto:
 *
 *   10:00 BRT (13:00 UTC)  WORKER_SYNC_CRON              traz D-1 retardatario
 *   10:15 BRT (13:15 UTC)  SHOPIFY_PRECLOSE_..._CRON     resolve o gateway dele
 *   10:40 BRT (13:40 UTC)  MATERIALIZE_CRONS["40 13..."] vira linha materializada
 *   10:50 BRT (13:50 UTC)  SHOPIFY_VERIFY_CRON           confere e emite o recibo
 *
 * Mexer no minuto de um sem olhar os outros quebra a meta das 11:00 BRT mesmo
 * com todos eles rodando "no horario".
 */
const WORKER_SYNC_CRON = "0 1,4,7,10,13,16,19,22 * * *";
const SHOPIFY_RESOLUTION_CRON = "0 */2 * * *";
const SHOPIFY_PRECLOSE_RESOLUTION_CRON = "15 13 * * *";
const SHOPIFY_VERIFY_CRON = "50 13 * * *";

/**
 * Materializacao diaria, um dia por invocacao.
 *
 * Tres horarios em vez de uma chamada com os tres dias porque cada dia varre
 * uma janela de 5 dias de chaves (folga de +-2) e nao caberia no maxDuration
 * de 300 s da rota. Separado tambem isola a falha: se D-2 estourar, D-0 ja
 * terminou.
 *
 * D-1 roda de MANHA, e nao junto dos outros as 23 h. O passe D-0 das 23 h le um
 * dia que ainda esta acontecendo: o mirror e alimentado por um sync de 3 em 3
 * horas, entao as ultimas horas do dia ainda nao chegaram. Medido em
 * 25/08/2026: 1.365 dos 1.738 pedidos Shopify do dia, 78,5% -- as telas
 * mostravam R$ 207.402,93 contra R$ 264.683,09 reais. Com D-1 as 23:15, a
 * correcao so chegava na noite SEGUINTE, ou seja o dia inteiro em que aquela
 * data e "Ontem" era exibido incompleto.
 *
 * D-1 roda DUAS vezes, com papeis diferentes:
 *
 * 07:30 BRT -- a TELA DA MANHA. Vem 30 min depois do sync das 07:00, e existe
 * para quem abre o sistema cedo ver "Ontem" ja correto. Nao e' o numero final.
 *
 * 10:40 BRT -- o FECHAMENTO. As 07:30 nao basta porque pedido ainda e pago
 * depois disso: medido em 30/08/2026, o passe da manha rodou 09:31:27Z e 6
 * pedidos Appmax so receberam `orders/paid` no mirror entre 10:18Z e 10:34Z --
 * ainda estavam `pending` quando o passe olhou, e R$ 778,25 ficaram de fora
 * justamente enquanto aquela data era "Ontem" na tela. O passe D-2 curava, mas
 * so na noite seguinte.
 *
 * Os dois horarios sao 1 h mais tarde que os anteriores (eram 06:30 e 11:05)
 * porque a fase do sync andou 1 h: 07:30 continua vindo logo apos um sync, e
 * 10:40 passou a vir depois do sync das 10:00 E da resolucao das 10:15, em vez
 * de depender do sync das 09:00 como antes.
 *
 * A fresta que existia aqui FECHOU. Antes, o sync mais recente as 11:05 era o
 * das 09:00, e quem fosse pago entre 09:00 e 11:05 so entrava no passe D-2.
 * Com o sync das 10:00 a janela cega caiu de 2 h05 para 40 min.
 *
 * Continuam 4 invocacoes/dia: e troca de horario, nao aumento de cadencia.
 */
const MATERIALIZE_CRONS: Record<string, number> = {
  "0 2 * * *": 0,
  "30 10 * * *": -1,
  "40 13 * * *": -1,
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
      // Mesma rota do passe regular, parametros diferentes: aqui o objetivo e'
      // DRENAR a fila antes da materializacao das 10:40, nao so avanca-la.
      case SHOPIFY_PRECLOSE_RESOLUTION_CRON: {
        const batchSize = env.SHOPIFY_PRECLOSE_BATCH_SIZE ?? "300";
        const sinceDays = env.SHOPIFY_PRECLOSE_SINCE_DAYS ?? "2";
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
