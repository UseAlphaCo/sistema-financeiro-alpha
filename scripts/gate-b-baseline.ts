import dotenv from "dotenv";
import { Client } from "pg";

dotenv.config();

type BaselineSnapshot = {
  generatedAt: string;
  app: {
    totals: {
      totalTransactions: number;
      incomeCents: string;
      outcomeCents: string;
      balanceCents: string;
    };
    last30Days: {
      txLast30d: number;
      incomeLast30d: string;
      outcomeLast30d: string;
    };
    imports: {
      totalBatches: number;
    };
    webhooks: {
      totalWebhooks: number;
    };
  };
  mirror: {
    totalRawPayloads: number;
  };
};

async function run() {
  const appDb = process.env.DATABASE_URL;
  const mirrorDb = process.env.CORE_DB_URL;

  if (!appDb) {
    throw new Error("DATABASE_URL nao configurada");
  }

  if (!mirrorDb) {
    throw new Error("CORE_DB_URL nao configurada");
  }

  const appClient = new Client({ connectionString: appDb });
  const mirrorClient = new Client({ connectionString: mirrorDb });

  await appClient.connect();
  await mirrorClient.connect();

  try {
    const totals = await appClient.query<{
      total_transactions: number;
      income_cents: string;
      outcome_cents: string;
      balance_cents: string;
    }>(`
      SELECT
        COUNT(*)::int AS total_transactions,
        COALESCE(SUM(CASE WHEN type = 'income' THEN "amountCents" ELSE 0 END),0)::bigint AS income_cents,
        COALESCE(SUM(CASE WHEN type <> 'income' THEN "amountCents" ELSE 0 END),0)::bigint AS outcome_cents,
        COALESCE(SUM(CASE WHEN type = 'income' THEN "amountCents" ELSE -"amountCents" END),0)::bigint AS balance_cents
      FROM public."FinancialTransaction"
      WHERE "deletedAt" IS NULL
    `);

    const last30 = await appClient.query<{
      tx_last_30d: number;
      income_last_30d: string;
      outcome_last_30d: string;
    }>(`
      SELECT
        COUNT(*)::int AS tx_last_30d,
        COALESCE(SUM(CASE WHEN type = 'income' THEN "amountCents" ELSE 0 END),0)::bigint AS income_last_30d,
        COALESCE(SUM(CASE WHEN type <> 'income' THEN "amountCents" ELSE 0 END),0)::bigint AS outcome_last_30d
      FROM public."FinancialTransaction"
      WHERE "deletedAt" IS NULL
        AND "occurredAt" >= NOW() - INTERVAL '30 days'
    `);

    const imports = await appClient.query<{ total_batches: number }>(`
      SELECT COUNT(*)::int AS total_batches
      FROM public."ImportBatch"
    `);

    const webhooks = await appClient.query<{ total_webhooks: number }>(`
      SELECT COUNT(*)::int AS total_webhooks
      FROM public."WebhookEvent"
    `);

    const mirror = await mirrorClient.query<{ total_raw_payloads: number }>(`
      SELECT COUNT(*)::int AS total_raw_payloads
      FROM mirror.raw_payloads
    `);

    const snapshot: BaselineSnapshot = {
      generatedAt: new Date().toISOString(),
      app: {
        totals: {
          totalTransactions: totals.rows[0]?.total_transactions ?? 0,
          incomeCents: totals.rows[0]?.income_cents ?? "0",
          outcomeCents: totals.rows[0]?.outcome_cents ?? "0",
          balanceCents: totals.rows[0]?.balance_cents ?? "0",
        },
        last30Days: {
          txLast30d: last30.rows[0]?.tx_last_30d ?? 0,
          incomeLast30d: last30.rows[0]?.income_last_30d ?? "0",
          outcomeLast30d: last30.rows[0]?.outcome_last_30d ?? "0",
        },
        imports: {
          totalBatches: imports.rows[0]?.total_batches ?? 0,
        },
        webhooks: {
          totalWebhooks: webhooks.rows[0]?.total_webhooks ?? 0,
        },
      },
      mirror: {
        totalRawPayloads: mirror.rows[0]?.total_raw_payloads ?? 0,
      },
    };

    console.log(JSON.stringify(snapshot, null, 2));
  } finally {
    await Promise.all([appClient.end(), mirrorClient.end()]);
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
