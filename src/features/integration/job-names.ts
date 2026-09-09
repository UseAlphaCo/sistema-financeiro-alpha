/**
 * Nomes estaveis dos jobs de cron e a cadencia esperada de cada um.
 *
 * Modulo puro, sem dependencia de banco: e' consumido tanto pelas rotas de cron
 * (que gravam em integration.job_runs) quanto pelo painel de /integracoes (que
 * decide se uma execucao esta atrasada). Um nome divergente entre as duas
 * pontas faria o painel mostrar "nunca rodou" para um job que roda todo dia.
 *
 * A fonte de verdade do agendamento e' `triggers.crons` em
 * cloudflare/worker-sync-cron/wrangler.jsonc. O que esta aqui e' a expectativa
 * derivada dele — se a cadencia mudar la, `expectedEveryMinutes` muda aqui.
 */

export const JOB_NAMES = {
  workerSync: "worker-sync",
  materializeOrders: "materialize-orders",
  shopifyPaymentResolution: "shopify-payment-resolution",
  shopifyVerify: "shopify-verify",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export type JobExpectation = {
  name: JobName;
  label: string;
  /**
   * Intervalo maximo tolerado entre execucoes, em minutos.
   *
   * Nao e' o intervalo do cron: e' o intervalo mais a folga. Um job de 3 em 3
   * horas com tolerancia de 180 min acusaria atraso a cada pequeno deslize de
   * horario do Cloudflare. A folga adotada e' ~30% do intervalo, com minimo de
   * 30 min.
   */
  staleAfterMinutes: number;
  /** Execucoes esperadas em 24 h, para conferir contra o que foi registrado. */
  expectedPerDay: number;
};

// Derivado de triggers.crons em wrangler.jsonc, em 08/09/2026:
//   "0 */3 * * *"                 -> worker-sync                 (8/dia)
//   "0 */2 * * *"                 -> shopify-payment-resolution  (12/dia)
//   "0 9 * * *"                   -> shopify-verify              (1/dia)
//   "0 2", "30 9", "5 14", "30 2" -> materialize-orders          (4/dia)
export const JOB_EXPECTATIONS: JobExpectation[] = [
  {
    name: JOB_NAMES.workerSync,
    label: "Sync OMS → mirror",
    staleAfterMinutes: 240,
    expectedPerDay: 8,
  },
  {
    name: JOB_NAMES.materializeOrders,
    label: "Materialização de pedidos",
    // O maior intervalo entre passes e' o das 11:05 BRT para as 23:00 BRT,
    // ou seja ~12 h. A tolerancia acompanha o maior vao, nao a media.
    staleAfterMinutes: 900,
    expectedPerDay: 4,
  },
  {
    name: JOB_NAMES.shopifyPaymentResolution,
    label: "Resolução de gateway Shopify",
    staleAfterMinutes: 180,
    expectedPerDay: 12,
  },
  {
    name: JOB_NAMES.shopifyVerify,
    label: "Verificação contra a Shopify",
    staleAfterMinutes: 1560,
    expectedPerDay: 1,
  },
];
