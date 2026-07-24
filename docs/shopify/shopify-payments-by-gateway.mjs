#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";

const PAYMENT_KINDS = new Set(["sale", "capture", "change", "refund"]);
const SUCCESS_STATUS = "success";

const args = parseArgs(process.argv.slice(2));
const env = withAliases({ ...loadEnv(".env"), ...process.env });
const date = args.date ?? yesterdayInTimeZone(args.timezone ?? "America/Bahia");
const timezone = args.timezone ?? "America/Bahia";
const windowUtc = dayWindowUtc(date, timezone);

const requiredEnv = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_ACCESS_TOKEN"];
for (const key of requiredEnv) {
  if (!env[key]) throw new Error(`Missing required env: ${key}`);
}

if (!hasSqlSource(env)) {
  throw new Error("Missing SQL source: set SUPABASE_PROJECT_REF+SUPABASE_ACCESS_TOKEN or OMS_DB_URL.");
}

const rawPaidOrders = await loadRawPaidOrders(date, timezone);
const rawPaidOrderIds = new Set(rawPaidOrders.map((order) => order.external_order_id));
const rawOrderIdsInDay = await loadRawOrderIdsInDay(date, timezone);
const primaryGatewayReport = summarizeRawByPrimaryGateway(rawPaidOrders);

const tenderOrderIds = await loadTenderTransactionOrderIds(date, windowUtc);
for (const orderId of rawPaidOrderIds) tenderOrderIds.add(orderId);
for (const orderId of rawOrderIdsInDay) tenderOrderIds.add(orderId);

const paymentTransactions = await loadOrderTransactions([...tenderOrderIds], windowUtc);
const shopifyTransactionsReport = summarizeTransactions(paymentTransactions);
const rawPaidTransactionsReport = summarizeTransactions(
  paymentTransactions.filter((transaction) => rawPaidOrderIds.has(transaction.order_id))
);

const output = {
  date,
  timezone,
  window_utc: {
    start: windowUtc.start.toISOString(),
    end_exclusive: windowUtc.end.toISOString()
  },
  source: {
    oms_raw_paid_orders: {
      description: "Pedidos pagos no raw payload, por created_at do pedido. Nao rateia split sem transacoes.",
      orders: rawPaidOrders.length,
      total_order_price: money(sum(rawPaidOrders.map((order) => order.total_price))),
      by_primary_gateway: primaryGatewayReport
    },
    shopify_payment_transactions: {
      description: "Transacoes Shopify filtradas por processed_at, kind sale/capture/change/refund e status success. Rateia split por transaction.gateway.",
      candidate_orders: tenderOrderIds.size,
      raw_order_candidates: rawOrderIdsInDay.size,
      by_gateway: shopifyTransactionsReport
    },
    raw_paid_orders_split_aware: {
      description: "Somente pedidos pagos do raw, mas valores alocados por transaction.gateway quando ha split.",
      by_gateway: rawPaidTransactionsReport
    }
  }
};

printReport(output);

async function loadRawPaidOrders(reportDate, reportTimezone) {
  const query = `
    with bounds as (
      select
        ('${sqlLiteral(reportDate)}'::date::timestamp at time zone '${sqlLiteral(reportTimezone)}') as starts_at,
        (('${sqlLiteral(reportDate)}'::date + interval '1 day')::timestamp at time zone '${sqlLiteral(reportTimezone)}') as ends_at
    ), latest as (
      select distinct on (rp.external_order_id) rp.*
      from raw_payloads rp, bounds b
      where rp.source = 'shopify'
        and (rp.payload_json->>'created_at')::timestamptz >= b.starts_at
        and (rp.payload_json->>'created_at')::timestamptz < b.ends_at
        and rp.payload_json->>'financial_status' = 'paid'
      order by rp.external_order_id, rp.received_at desc, rp.id desc
    )
    select
      external_order_id,
      payload_json->>'name' as order_name,
      payload_json->'payment_gateway_names' as payment_gateway_names,
      coalesce(nullif(payload_json->>'total_price', '')::numeric, 0)::text as total_price,
      coalesce(nullif(payload_json->>'total_line_items_price', '')::numeric, 0)::text as items_total
    from latest
    order by external_order_id;
  `;
  const rows = await supabaseSql(query);
  return rows.map((row) => ({
    external_order_id: String(row.external_order_id),
    order_name: row.order_name,
    payment_gateway_names: Array.isArray(row.payment_gateway_names) ? row.payment_gateway_names : [],
    total_price: Number(row.total_price),
    items_total: Number(row.items_total)
  }));
}

async function loadRawOrderIdsInDay(reportDate, reportTimezone) {
  const query = `
    with bounds as (
      select
        ('${sqlLiteral(reportDate)}'::date::timestamp at time zone '${sqlLiteral(reportTimezone)}') as starts_at,
        (('${sqlLiteral(reportDate)}'::date + interval '1 day')::timestamp at time zone '${sqlLiteral(reportTimezone)}') as ends_at
    ), latest as (
      select distinct on (rp.external_order_id) rp.external_order_id
      from raw_payloads rp, bounds b
      where rp.source = 'shopify'
        and (rp.payload_json->>'created_at')::timestamptz >= b.starts_at
        and (rp.payload_json->>'created_at')::timestamptz < b.ends_at
      order by rp.external_order_id, rp.received_at desc, rp.id desc
    )
    select external_order_id
    from latest
    order by external_order_id;
  `;
  const rows = await supabaseSql(query);
  return new Set(rows.map((row) => String(row.external_order_id)));
}

async function loadTenderTransactionOrderIds(reportDate, window) {
  const query = `
    query TenderTransactions($first: Int!, $after: String, $query: String!) {
      tenderTransactions(first: $first, after: $after, query: $query) {
        edges {
          node {
            processedAt
            order {
              legacyResourceId
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const searchQuery = `processed_at:>=${reportDate} processed_at:<=${nextDate(reportDate)}`;
  const ids = new Set();
  let after;

  do {
    const data = await shopifyGraphql(query, { first: 250, after, query: searchQuery });
    const connection = data.tenderTransactions;
    for (const edge of connection.edges) {
      const processedAt = new Date(edge.node.processedAt);
      if (processedAt >= window.start && processedAt < window.end && edge.node.order?.legacyResourceId) {
        ids.add(String(edge.node.order.legacyResourceId));
      }
    }
    after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : undefined;
  } while (after);

  return ids;
}

async function loadOrderTransactions(orderIds, window) {
  const rows = [];
  let index = 0;
  const concurrency = Number(args.concurrency ?? 8);

  async function worker() {
    while (index < orderIds.length) {
      const orderId = orderIds[index++];
      const transactions = await shopifyRest(`/orders/${encodeURIComponent(orderId)}/transactions.json`);
      for (const transaction of transactions.transactions ?? []) {
        const processedAt = new Date(transaction.processed_at);
        if (processedAt < window.start || processedAt >= window.end) continue;
        if (!PAYMENT_KINDS.has(transaction.kind)) continue;
        if (transaction.status !== SUCCESS_STATUS) continue;
        rows.push({
          order_id: String(orderId),
          id: String(transaction.id),
          gateway: transaction.gateway || "sem_gateway",
          kind: transaction.kind,
          status: transaction.status,
          amount: Number(transaction.amount ?? 0),
          processed_at: transaction.processed_at,
          parent_id: transaction.parent_id ? String(transaction.parent_id) : undefined
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return rows;
}

function summarizeRawByPrimaryGateway(orders) {
  const grouped = new Map();
  for (const order of orders) {
    const gateway = order.payment_gateway_names[0] || "sem_gateway";
    const current = grouped.get(gateway) ?? { gateway, orders: 0, gross_payments: 0, gross_items: 0, split_orders: 0 };
    current.orders += 1;
    current.gross_payments += order.total_price;
    current.gross_items += order.items_total;
    if (order.payment_gateway_names.length > 1) current.split_orders += 1;
    grouped.set(gateway, current);
  }
  return formatGrouped([...grouped.values()]);
}

function summarizeTransactions(transactions) {
  const grouped = new Map();
  for (const transaction of transactions) {
    const current = grouped.get(transaction.gateway) ?? {
      gateway: transaction.gateway,
      gross_payments: 0,
      refunded_payments: 0,
      net_payments: 0,
      payment_transaction_rows: 0,
      order_ids: new Set()
    };

    current.payment_transaction_rows += 1;
    current.order_ids.add(transaction.order_id);
    if (transaction.kind === "refund") current.refunded_payments += Math.abs(transaction.amount);
    else current.gross_payments += transaction.amount;
    current.net_payments = current.gross_payments - current.refunded_payments;
    grouped.set(transaction.gateway, current);
  }

  return formatGrouped(
    [...grouped.values()].map((row) => ({
      ...row,
      orders_with_gateway_payment: row.order_ids.size
    }))
  );
}

function formatGrouped(rows) {
  return rows
    .sort((left, right) => Number(right.net_payments ?? right.gross_payments) - Number(left.net_payments ?? left.gross_payments))
    .map((row) => {
      const formatted = { ...row };
      delete formatted.order_ids;
      for (const key of ["gross_payments", "gross_items", "refunded_payments", "net_payments"]) {
        if (key in formatted) formatted[key] = money(formatted[key]);
      }
      return formatted;
    });
}

async function supabaseSql(query) {
  if (env.OMS_DB_URL) {
    const client = new Client({ connectionString: env.OMS_DB_URL });
    await client.connect();
    try {
      const result = await client.query(query);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  const response = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ query })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase query failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

function withAliases(values) {
  const next = { ...values };

  if (!next.SHOPIFY_SHOP_DOMAIN && next.SHOPIFY_STORE_URL) {
    try {
      next.SHOPIFY_SHOP_DOMAIN = new URL(next.SHOPIFY_STORE_URL).host;
    } catch {
      next.SHOPIFY_SHOP_DOMAIN = String(next.SHOPIFY_STORE_URL).replace(/^https?:\/\//, "").replace(/\/$/, "");
    }
  }

  if (!next.SUPABASE_PROJECT_REF && next.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const host = new URL(next.NEXT_PUBLIC_SUPABASE_URL).host;
      next.SUPABASE_PROJECT_REF = host.split(".")[0];
    } catch {
      // Keep original values when URL parsing fails.
    }
  }

  return next;
}

function hasSqlSource(values) {
  return Boolean(
    values.OMS_DB_URL || (values.SUPABASE_PROJECT_REF && values.SUPABASE_ACCESS_TOKEN)
  );
}

async function shopifyGraphql(query, variables) {
  const response = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "x-shopify-access-token": env.SHOPIFY_ACCESS_TOKEN,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({ query, variables })
  });
  const json = await response.json();
  if (!response.ok || json.errors) {
    throw new Error(`Shopify GraphQL failed: ${response.status} ${JSON.stringify(json.errors ?? json)}`);
  }
  return json.data;
}

async function shopifyRest(path) {
  const response = await fetch(`https://${env.SHOPIFY_SHOP_DOMAIN}/admin/api/2026-01${path}`, {
    headers: {
      "x-shopify-access-token": env.SHOPIFY_ACCESS_TOKEN,
      accept: "application/json"
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Shopify REST failed: ${response.status} ${text}`);
  return JSON.parse(text);
}

function printReport(report) {
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Shopify payments by gateway`);
  console.log(`Date: ${report.date} (${report.timezone})`);
  console.log(`UTC window: ${report.window_utc.start} -> ${report.window_utc.end_exclusive}`);
  console.log("");

  console.log("OMS raw paid orders, primary gateway:");
  console.table(report.source.oms_raw_paid_orders.by_primary_gateway);
  console.log("");

  console.log("Shopify payment transactions, split-aware:");
  console.table(report.source.shopify_payment_transactions.by_gateway);
  console.log("");

  console.log("Raw paid orders, split-aware allocation:");
  console.table(report.source.raw_paid_orders_split_aware.by_gateway);
}

function loadEnv(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function dayWindowUtc(reportDate, reportTimezone) {
  const start = zonedDateToUtc(reportDate, "00:00:00", reportTimezone);
  const end = zonedDateToUtc(nextDate(reportDate), "00:00:00", reportTimezone);
  return { start, end };
}

function zonedDateToUtc(reportDate, time, reportTimezone) {
  const guess = new Date(`${reportDate}T${time}.000Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: reportTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
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

function nextDate(reportDate) {
  const next = new Date(`${reportDate}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

function yesterdayInTimeZone(reportTimezone) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: reportTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

function money(value) {
  return Number(value).toFixed(2);
}

function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}
