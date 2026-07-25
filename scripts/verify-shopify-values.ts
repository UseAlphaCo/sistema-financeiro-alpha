/**
 * Verificacao de valores: Sistema Financeiro vs Shopify (v1)
 *
 * Compara, para um dia especifico, o que o Fluxo de Caixa do Sistema
 * Financeiro mostra (faturamento bruto e numero de transacoes/pedidos)
 * contra o que a Shopify realmente processou naquele dia, via API real.
 *
 * Lado Sistema Financeiro: chama computeCashFlow() diretamente — a mesma
 * funcao que alimenta a tela /financeiro/fluxo-de-caixa — para garantir que
 * o numero comparado e exatamente o que a equipe ja ve na tela.
 *
 * Lado Shopify: reusa a metodologia validada em
 * docs/shopify/shopify-payments-by-gateway.md (tenderTransactions + REST
 * orders/{id}/transactions.json, filtrado por transaction.processed_at, kind
 * sale/capture/change, status success).
 *
 * "Transacoes" aqui = pedidos pagos (nao eventos de pagamento da Shopify) —
 * ver docs/shopify/shopify-payments-by-gateway.md sobre a diferenca.
 *
 * Uso:
 *   npx tsx scripts/verify-shopify-values.ts [--date=YYYY-MM-DD] [--json]
 *     [--csv=caminho.csv] [--tolerance-cents=1] [--concurrency=5]
 *
 * Sem --date, verifica o dia anterior em America/Bahia.
 */

import { writeFileSync } from "node:fs";

import dotenv from "dotenv";
import { Pool } from "pg";

import { computeCashFlow } from "../src/features/cash-flow/service";
import {
  fetchShopifyOrderTransactions,
  type ShopifyOrderTransaction,
} from "../src/features/integration/shopify-order-transactions";
import { normalizeShopifyStoreDomain, stripWrappingQuotes } from "../src/features/integration/shopify-orders-sync";
import { getCoreConnectionString } from "../src/shared/read-model-config";

dotenv.config();

const GROSS_KINDS = new Set(["sale", "capture", "change"]);
const SUCCESS_STATUS = "success";
const TIMEZONE = "America/Bahia";

type Args = {
  date?: string;
  json: boolean;
  csv?: string;
  toleranceCents: number;
  concurrency: number;
};

type ShopifySide = {
  grossCents: number;
  orderCount: number;
  candidateOrders: number;
};

type SyncFreshness = {
  mirrorOrders: number;
  unresolvedOrders: number;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date ?? yesterdayInTimeZone(TIMEZONE);
  const window = dayWindowUtc(date, TIMEZONE);

  const storeDomain = normalizeShopifyStoreDomain(process.env.SHOPIFY_STORE_URL ?? "");
  const accessToken = stripWrappingQuotes(process.env.SHOPIFY_ACCESS_TOKEN ?? "");
  if (!storeDomain) throw new Error("SHOPIFY_STORE_URL ausente ou invalido no .env");
  if (!accessToken) throw new Error("SHOPIFY_ACCESS_TOKEN ausente no .env");

  const [financeiro, shopify, freshness] = await Promise.all([
    computeCashFlow({ startDate: date, endDate: date, marketplace: "Shopify" }),
    loadShopifySide(storeDomain, accessToken, date, window, args.concurrency),
    loadSyncFreshness(window),
  ]);

  const financeiroSource = financeiro.bySource.find((entry) => entry.source === "Shopify");
  const financeiroGrossCents = financeiroSource?.grossCents ?? 0;
  const financeiroOrderCount = financeiroSource?.transactionCount ?? 0;

  const report = {
    date,
    timezone: TIMEZONE,
    windowUtc: { start: window.start.toISOString(), endExclusive: window.end.toISOString() },
    metrics: [
      buildMetric(
        "Faturamento bruto",
        financeiroGrossCents,
        shopify.grossCents,
        args.toleranceCents,
        formatMoney
      ),
      buildMetric(
        "Nº de transações (pedidos pagos)",
        financeiroOrderCount,
        shopify.orderCount,
        0,
        (value) => String(value)
      ),
    ],
    syncFreshness: freshness,
    shopifyCandidateOrders: shopify.candidateOrders,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (args.csv) {
    writeCsv(args.csv, report);
    console.log(`\nCSV salvo em: ${args.csv}`);
  }

  const hasDivergence = report.metrics.some((metric) => metric.diverges);
  process.exitCode = hasDivergence ? 1 : 0;
}

function buildMetric(
  label: string,
  financeiroValue: number,
  shopifyValue: number,
  toleranceCents: number,
  format: (value: number) => string
) {
  const diff = financeiroValue - shopifyValue;
  const diffPct = shopifyValue !== 0 ? (diff / shopifyValue) * 100 : financeiroValue === 0 ? 0 : 100;

  return {
    label,
    financeiro: format(financeiroValue),
    shopify: format(shopifyValue),
    diff: format(diff),
    diffPct: `${diffPct.toFixed(2)}%`,
    diverges: Math.abs(diff) > toleranceCents,
  };
}

async function loadShopifySide(
  storeDomain: string,
  accessToken: string,
  date: string,
  window: { start: Date; end: Date },
  concurrency: number
): Promise<ShopifySide> {
  const orderIds = await loadTenderTransactionOrderIds(storeDomain, accessToken, date, window);
  const transactions = await loadOrderTransactions(storeDomain, accessToken, [...orderIds], window, concurrency);

  const grossByOrder = new Map<string, number>();
  for (const { orderId, transaction } of transactions) {
    if (transaction.status !== SUCCESS_STATUS) continue;
    if (!GROSS_KINDS.has(transaction.kind)) continue;
    grossByOrder.set(orderId, (grossByOrder.get(orderId) ?? 0) + transaction.amountCents);
  }

  const grossCents = [...grossByOrder.values()].reduce((sum, value) => sum + value, 0);

  return {
    grossCents,
    orderCount: grossByOrder.size,
    candidateOrders: orderIds.size,
  };
}

async function loadTenderTransactionOrderIds(
  storeDomain: string,
  accessToken: string,
  date: string,
  window: { start: Date; end: Date }
): Promise<Set<string>> {
  const query = `
    query TenderTransactions($first: Int!, $after: String, $query: String!) {
      tenderTransactions(first: $first, after: $after, query: $query) {
        edges {
          node {
            processedAt
            order { legacyResourceId }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const searchQuery = `processed_at:>=${date} processed_at:<=${nextDate(date)}`;
  const ids = new Set<string>();
  let after: string | undefined;

  do {
    const data = await shopifyGraphql(storeDomain, accessToken, query, { first: 250, after, query: searchQuery });
    const connection = data.tenderTransactions;
    for (const edge of connection.edges) {
      const processedAt = new Date(edge.node.processedAt);
      const orderId = edge.node.order?.legacyResourceId;
      if (processedAt >= window.start && processedAt < window.end && orderId) {
        ids.add(String(orderId));
      }
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return ids;
}

async function loadOrderTransactions(
  storeDomain: string,
  accessToken: string,
  orderIds: string[],
  window: { start: Date; end: Date },
  concurrency: number
): Promise<Array<{ orderId: string; transaction: ShopifyOrderTransaction }>> {
  const results: Array<{ orderId: string; transaction: ShopifyOrderTransaction }> = [];
  let index = 0;

  async function worker() {
    while (index < orderIds.length) {
      const orderId = orderIds[index++];
      const transactions = await fetchShopifyOrderTransactions(storeDomain, accessToken, orderId);
      for (const transaction of transactions) {
        if (!transaction.processedAt) continue;
        const processedAt = new Date(transaction.processedAt);
        if (processedAt < window.start || processedAt >= window.end) continue;
        results.push({ orderId, transaction });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  return results;
}

async function loadSyncFreshness(window: { start: Date; end: Date }): Promise<SyncFreshness> {
  const connectionString = getCoreConnectionString();
  if (!connectionString) return { mirrorOrders: 0, unresolvedOrders: 0 };

  const pool = new Pool({ connectionString, application_name: "verify-shopify-values", max: 1 });
  try {
    const mirrorResult = await pool.query<{ mirror_orders: string }>(
      `
      SELECT count(DISTINCT rp.external_order_id) AS mirror_orders
      FROM mirror.raw_payloads rp
      WHERE rp.source = 'shopify'
        AND rp.payload_json IS NOT NULL
        AND (rp.payload_json->>'created_at')::timestamptz >= $1
        AND (rp.payload_json->>'created_at')::timestamptz < $2
      `,
      [window.start, window.end]
    );
    const mirrorOrders = Number(mirrorResult.rows[0]?.mirror_orders ?? 0);

    try {
      const unresolvedResult = await pool.query<{ unresolved_orders: string }>(
        `
        SELECT count(DISTINCT rp.external_order_id) AS unresolved_orders
        FROM mirror.raw_payloads rp
        LEFT JOIN integration.shopify_order_payment_resolution spr
          ON spr.external_order_id = rp.external_order_id
        WHERE rp.source = 'shopify'
          AND rp.payload_json IS NOT NULL
          AND (rp.payload_json->>'created_at')::timestamptz >= $1
          AND (rp.payload_json->>'created_at')::timestamptz < $2
          AND spr.external_order_id IS NULL
        `,
        [window.start, window.end]
      );
      return { mirrorOrders, unresolvedOrders: Number(unresolvedResult.rows[0]?.unresolved_orders ?? 0) };
    } catch (err) {
      // Tabela do job de resolução pode não existir ainda neste ambiente
      // (criada sob demanda por ensureShopifyPaymentResolutionTable). Não é
      // erro fatal para a verificação de faturamento/contagem.
      if (err instanceof Error && /does not exist/i.test(err.message)) {
        return { mirrorOrders, unresolvedOrders: mirrorOrders };
      }
      throw err;
    }
  } finally {
    await pool.end();
  }
}

function printReport(report: {
  date: string;
  timezone: string;
  windowUtc: { start: string; endExclusive: string };
  metrics: ReturnType<typeof buildMetric>[];
  syncFreshness: SyncFreshness;
  shopifyCandidateOrders: number;
}) {
  console.log(`Verificação de valores — Sistema Financeiro vs Shopify`);
  console.log(`Data: ${report.date} (${report.timezone})`);
  console.log(`Janela UTC: ${report.windowUtc.start} -> ${report.windowUtc.endExclusive}`);
  console.log("");

  console.table(
    report.metrics.map((metric) => ({
      Métrica: metric.label,
      "Sistema Financeiro": metric.financeiro,
      Shopify: metric.shopify,
      Diferença: metric.diff,
      "Diferença %": metric.diffPct,
      Status: metric.diverges ? "⚠ DIVERGÊNCIA" : "OK",
    }))
  );

  console.log("");
  console.log("Contexto de frescor de sincronização (mirror.raw_payloads / job de resolução de gateway):");
  console.log(`  Pedidos Shopify no mirror no dia: ${report.syncFreshness.mirrorOrders}`);
  console.log(`  Ainda sem resolução de gateway: ${report.syncFreshness.unresolvedOrders}`);
  if (report.syncFreshness.unresolvedOrders > 0) {
    console.log(
      "  Nota: pedidos sem resolução usam data heurística (processed_at/created_at do pedido) em vez da" +
        " data real do pagamento — pode causar pequena divergência de janela explicável."
    );
  }
  console.log(`  Pedidos candidatos consultados na Shopify (tenderTransactions): ${report.shopifyCandidateOrders}`);
}

function writeCsv(
  path: string,
  report: { metrics: ReturnType<typeof buildMetric>[] }
) {
  const header = "Metrica;Sistema Financeiro;Shopify;Diferenca;Diferenca %;Status";
  const rows = report.metrics.map((metric) =>
    [
      metric.label,
      metric.financeiro,
      metric.shopify,
      metric.diff,
      metric.diffPct,
      metric.diverges ? "DIVERGENCIA" : "OK",
    ].join(";")
  );
  writeFileSync(path, `﻿${[header, ...rows].join("\n")}\n`, "utf8");
}

type TenderTransactionsResponse = {
  tenderTransactions: {
    edges: Array<{ node: { processedAt: string; order: { legacyResourceId: string } | null } }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string };
  };
};

async function shopifyGraphql(
  storeDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
  retries = 2
): Promise<TenderTransactionsResponse> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(`https://${storeDomain}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ query, variables }),
        // Timeout generoso (rede local as vezes lenta ate a Shopify, ja
        // observado) — mas sempre limitado, nunca em aberto (uma execucao
        // anterior deste script travou ~3h com fetch sem timeout nenhum).
        signal: AbortSignal.timeout(30_000),
      });
      const json = await response.json();
      if (!response.ok || json.errors) {
        throw new Error(`Shopify GraphQL falhou: ${response.status} ${JSON.stringify(json.errors ?? json)}`);
      }
      return json.data;
    } catch (error) {
      if (attempt >= retries) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
}

function formatMoney(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function parseArgs(argv: string[]): Args {
  const parsed: Record<string, string | boolean> = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=");
    parsed[key] = value ?? true;
  }

  return {
    date: typeof parsed.date === "string" ? parsed.date : undefined,
    json: Boolean(parsed.json),
    csv: typeof parsed.csv === "string" ? parsed.csv : undefined,
    toleranceCents: typeof parsed["tolerance-cents"] === "string" ? Number(parsed["tolerance-cents"]) : 1,
    concurrency: typeof parsed.concurrency === "string" ? Number(parsed.concurrency) : 5,
  };
}

function dayWindowUtc(date: string, timezone: string): { start: Date; end: Date } {
  return {
    start: zonedDateToUtc(date, "00:00:00", timezone),
    end: zonedDateToUtc(nextDate(date), "00:00:00", timezone),
  };
}

function zonedDateToUtc(date: string, time: string, timezone: string): Date {
  const guess = new Date(`${date}T${time}.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(guess);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asIfUtc = Date.UTC(
    Number(value.year),
    Number(value.month) - 1,
    Number(value.day),
    Number(value.hour),
    Number(value.minute),
    Number(value.second)
  );
  const offset = asIfUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function nextDate(date: string): string {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function yesterdayInTimeZone(timezone: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
