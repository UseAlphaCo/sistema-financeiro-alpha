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

export async function fetchShopifyOrderTransactions(
  storeDomain: string,
  accessToken: string,
  orderId: string | number
): Promise<ShopifyOrderTransaction[]> {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
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
      break;
    } catch (error) {
      // Timeout/erro de rede transitorio — nunca ficar tentando pra sempre
      // (limite fixo de tentativas), mas absorve blips pontuais da rede local.
      if (attempt >= SHOPIFY_FETCH_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
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
export function resolveDominantPaymentMethod(
  transactions: ShopifyOrderTransaction[]
): DominantPaymentMethodResult | null {
  const totals = new Map<string, { amountCents: number; processedAt: string | null }>();

  for (const tx of transactions) {
    if (tx.status !== SUCCESS_STATUS) continue;
    if (!DOMINANT_PAYMENT_KINDS.has(tx.kind)) continue;

    const current = totals.get(tx.gateway) ?? { amountCents: 0, processedAt: null };
    current.amountCents += tx.amountCents;
    if (tx.processedAt && (!current.processedAt || tx.processedAt > current.processedAt)) {
      current.processedAt = tx.processedAt;
    }
    totals.set(tx.gateway, current);
  }

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
