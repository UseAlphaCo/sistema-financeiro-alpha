import { classifyPaymentMethod } from "@/features/transactions/payment-method-filter";

const DOMINANT_PAYMENT_KINDS = new Set(["sale", "capture", "change"]);
const SUCCESS_STATUS = "success";

// Desempate quando dois gateways somam o mesmo valor no pedido (raro): usa a
// mesma prioridade de classifyPaymentMethod, nunca como regra principal.
const TIEBREAK_PRIORITY = ["store_credit", "pix", "boleto", "bank_transfer", "credit_card", "wallet", "cash"];

export type ShopifyOrderTransaction = {
  gateway: string;
  kind: string;
  status: string;
  amountCents: number;
  processedAt: string | null;
};

export type DominantPaymentMethodResult = {
  gatewayRaw: string;
  dominantAmountCents: number;
  totalAmountCents: number;
  processedAt: string | null;
};

function parseAmountToCents(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100);
}

const SHOPIFY_FETCH_TIMEOUT_MS = 15_000;
const SHOPIFY_FETCH_RETRIES = 2;

/**
 * Tentativas dedicadas a 429 e 5xx, alem das de erro de rede.
 *
 * Separadas de proposito: um 429 nao e defeito, e a API pedindo ritmo. Antes
 * ele caia direto no `throw` de `!response.ok`, o pedido nao virava linha na
 * tabela de resolucao e -- como a fila ordena por `external_order_id DESC` -- o
 * MESMO pedido era a primeira coisa da rodada seguinte, batendo no mesmo limite.
 * O lote inteiro podia queimar assim.
 */
const SHOPIFY_RATE_LIMIT_RETRIES = 4;
const SHOPIFY_RATE_LIMIT_FALLBACK_MS = 2_000;

/**
 * Espera entre chamadas, por processo.
 *
 * O bucket REST da Shopify em plano nao-Plus reabastece a ~2 req/s. A
 * resolucao dispara com concorrencia 5 sem nenhum freio, o que excede o refill
 * de forma sustentada e transforma lote grande em sequencia de 429. Este
 * portao serializa a saida no ritmo do bucket: o paralelismo continua util para
 * cobrir latencia, mas a taxa media fica dentro do limite.
 */
const SHOPIFY_MIN_INTERVAL_MS = 500;
let proximaChamadaEm = 0;

async function aguardarVezNoBucket(): Promise<void> {
  const agora = Date.now();
  const alvo = Math.max(agora, proximaChamadaEm);
  proximaChamadaEm = alvo + SHOPIFY_MIN_INTERVAL_MS;
  const espera = alvo - agora;
  if (espera > 0) {
    await new Promise((resolve) => setTimeout(resolve, espera));
  }
}

/** Segundos pedidos no Retry-After, quando a Shopify manda um. */
function esperaPedidaPelaApi(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return SHOPIFY_RATE_LIMIT_FALLBACK_MS;
  const segundos = Number(header);
  if (!Number.isFinite(segundos) || segundos <= 0) return SHOPIFY_RATE_LIMIT_FALLBACK_MS;
  return Math.min(segundos * 1000, 30_000);
}

export async function fetchShopifyOrderTransactions(
  storeDomain: string,
  accessToken: string,
  orderId: string | number
): Promise<ShopifyOrderTransaction[]> {
  let response: Response;
  let tentativasDeLimite = 0;

  for (let attempt = 0; ; attempt++) {
    await aguardarVezNoBucket();

    try {
      response = await fetch(
        `https://${storeDomain}/admin/api/2024-10/orders/${encodeURIComponent(String(orderId))}/transactions.json`,
        {
          headers: {
            "X-Shopify-Access-Token": accessToken,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(SHOPIFY_FETCH_TIMEOUT_MS),
        }
      );
    } catch (error) {
      // Timeout/erro de rede transitorio — nunca ficar tentando pra sempre
      // (limite fixo de tentativas), mas absorve blips pontuais da rede local.
      if (attempt >= SHOPIFY_FETCH_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      continue;
    }

    const limiteOuInstabilidade = response.status === 429 || response.status >= 500;
    if (limiteOuInstabilidade && tentativasDeLimite < SHOPIFY_RATE_LIMIT_RETRIES) {
      tentativasDeLimite += 1;
      const espera = esperaPedidaPelaApi(response) * tentativasDeLimite;
      // Atrasa a fila inteira do processo, nao so esta chamada: se o bucket
      // estourou, as outras 4 em paralelo estao prestes a estourar tambem.
      proximaChamadaEm = Math.max(proximaChamadaEm, Date.now() + espera);
      await new Promise((resolve) => setTimeout(resolve, espera));
      continue;
    }

    break;
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Shopify transactions API retornou ${response.status}: ${body.slice(0, 200)}`);
  }

  const json = (await response.json()) as {
    transactions?: Array<{
      gateway?: string | null;
      kind?: string;
      status?: string;
      amount?: string | number;
      processed_at?: string | null;
    }>;
  };

  return (json.transactions ?? []).map((tx) => ({
    gateway: tx.gateway?.trim() || "sem_gateway",
    kind: tx.kind ?? "",
    status: tx.status ?? "",
    amountCents: parseAmountToCents(tx.amount),
    processedAt: tx.processed_at ?? null,
  }));
}

/**
 * Regra de negocio: quando um pedido divide o pagamento entre formas
 * diferentes, a forma titular e a que somar o MAIOR valor em R$ dentro do
 * pedido (nao a primeira listada, nem uma prioridade fixa de texto). So da
 * pra calcular isso com o valor por transacao — payment_gateway_names do
 * pedido nao carrega valor (ver docs/shopify/shopify-payments-by-gateway.md).
 */
type GatewayTotals = Map<string, { amountCents: number; processedAt: string | null; transactionCount: number }>;

function buildGatewayTotals(transactions: ShopifyOrderTransaction[]): GatewayTotals {
  const totals: GatewayTotals = new Map();

  for (const tx of transactions) {
    if (tx.status !== SUCCESS_STATUS) continue;
    if (!DOMINANT_PAYMENT_KINDS.has(tx.kind)) continue;

    const current = totals.get(tx.gateway) ?? { amountCents: 0, processedAt: null, transactionCount: 0 };
    current.amountCents += tx.amountCents;
    current.transactionCount += 1;
    if (tx.processedAt && (!current.processedAt || tx.processedAt > current.processedAt)) {
      current.processedAt = tx.processedAt;
    }
    totals.set(tx.gateway, current);
  }

  return totals;
}

export type GatewaySplitEntry = {
  gatewayRaw: string;
  amountCents: number;
  processedAt: string | null;
  /**
   * Quantas transacoes de pagamento este gateway teve no pedido.
   *
   * Existe porque a metrica "Transacoes" do relatorio da Shopify conta eventos
   * de pagamento, nao pedidos: em 30/08/2026 ela marcou 1.143 contra 1.128
   * pedidos. Contar aqui, na mesma passada que ja soma o valor, torna a
   * contagem exata por construcao em vez de aproximada por pares
   * (pedido, gateway) — ver docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md.
   */
  transactionCount: number;
};

/**
 * Rateio completo por gateway de um pedido (nao so o vencedor). Mesmo calculo
 * que resolveDominantPaymentMethod ja faz internamente e descartava — ver
 * docs/DIAGNOSTICO-PARIDADE-SHOPIFY-2026-08.md, Fase 1.
 */
export function resolvePaymentGatewaySplit(transactions: ShopifyOrderTransaction[]): GatewaySplitEntry[] {
  const totals = buildGatewayTotals(transactions);
  return [...totals.entries()].map(([gatewayRaw, entry]) => ({
    gatewayRaw,
    amountCents: entry.amountCents,
    processedAt: entry.processedAt,
    transactionCount: entry.transactionCount,
  }));
}

export function resolveDominantPaymentMethod(
  transactions: ShopifyOrderTransaction[]
): DominantPaymentMethodResult | null {
  const totals = buildGatewayTotals(transactions);

  if (totals.size === 0) return null;

  const totalAmountCents = [...totals.values()].reduce((sum, entry) => sum + entry.amountCents, 0);

  let winnerGateway: string | null = null;
  let winnerEntry: { amountCents: number; processedAt: string | null } | null = null;

  for (const [gateway, entry] of totals) {
    if (!winnerEntry || entry.amountCents > winnerEntry.amountCents) {
      winnerGateway = gateway;
      winnerEntry = entry;
      continue;
    }

    if (entry.amountCents === winnerEntry.amountCents) {
      const currentPriority = TIEBREAK_PRIORITY.indexOf(classifyPaymentMethod(gateway));
      const winnerPriority = TIEBREAK_PRIORITY.indexOf(classifyPaymentMethod(winnerGateway!));
      const normalizedCurrent = currentPriority === -1 ? TIEBREAK_PRIORITY.length : currentPriority;
      const normalizedWinner = winnerPriority === -1 ? TIEBREAK_PRIORITY.length : winnerPriority;
      if (normalizedCurrent < normalizedWinner) {
        winnerGateway = gateway;
        winnerEntry = entry;
      }
    }
  }

  if (!winnerGateway || !winnerEntry) return null;

  return {
    gatewayRaw: winnerGateway,
    dominantAmountCents: winnerEntry.amountCents,
    totalAmountCents,
    processedAt: winnerEntry.processedAt,
  };
}
