import { getPrismaClient } from "@/core/db/prisma-client";
import { getDateRangeForPeriod } from "@/lib/date-utils";
import type { ReconciliationFilters, ReconciliationIssue, ReconciliationResult } from "./types";

const prisma = getPrismaClient();

export async function runReconciliation(filters: ReconciliationFilters = {}): Promise<ReconciliationResult> {
  const days = filters.days ?? 30;
  const { start, end } =
    filters.startDate && filters.endDate
      ? { start: new Date(filters.startDate), end: new Date(filters.endDate) }
      : getDateRangeForPeriod(days);

  const issues: ReconciliationIssue[] = [];

  // 1. Transações com externalSource+externalId duplicados (além do par já bloqueado pelo unique)
  //    Detecta duplicatas de importação — linhas da mesma batch reimportadas com status rollback
  const duplicateRows = await prisma.$queryRaw<{ externalSource: string; externalId: string; cnt: bigint }[]>`
    SELECT "externalSource", "externalId", COUNT(*) as cnt
    FROM "FinancialTransaction"
    WHERE "deletedAt" IS NULL
      AND "externalSource" IS NOT NULL
      AND "occurredAt" BETWEEN ${start} AND ${end}
    GROUP BY "externalSource", "externalId"
    HAVING COUNT(*) > 1
  `;

  for (const row of duplicateRows) {
    issues.push({
      type: "duplicate_external_id",
      severity: "error",
      description: `Transação duplicada: fonte=${row.externalSource}, id=${row.externalId} (${Number(row.cnt)} ocorrências)`,
      affectedTable: "FinancialTransaction",
    });
  }

  // 2. Transações sem categoria no período
  const noCategory = await prisma.financialTransaction.findMany({
    where: {
      deletedAt: null,
      categoryId: null,
      occurredAt: { gte: start, lte: end },
    },
    select: { id: true, occurredAt: true, description: true },
    take: 50,
  });

  for (const tx of noCategory) {
    issues.push({
      type: "missing_category",
      severity: "warning",
      description: `Transação sem categoria: ${tx.description ?? tx.id}`,
      affectedId: tx.id,
      affectedTable: "FinancialTransaction",
      occurredAt: tx.occurredAt,
    });
  }

  // 3. Saldo líquido negativo acumulado no período
  const [incomeAgg, expenseAgg] = await Promise.all([
    prisma.financialTransaction.aggregate({
      _sum: { amountCents: true },
      where: { deletedAt: null, type: "income", occurredAt: { gte: start, lte: end } },
    }),
    prisma.financialTransaction.aggregate({
      _sum: { amountCents: true },
      where: { deletedAt: null, type: "expense", occurredAt: { gte: start, lte: end } },
    }),
  ]);

  const totalIncome = incomeAgg._sum.amountCents ?? 0;
  const totalExpense = expenseAgg._sum.amountCents ?? 0;
  const netCents = totalIncome - totalExpense;

  if (netCents < 0) {
    issues.push({
      type: "negative_balance",
      severity: "error",
      description: `Saldo líquido negativo no período: R$ ${(netCents / 100).toFixed(2).replace(".", ",")}`,
      affectedTable: "FinancialTransaction",
    });
  }

  // 4. Linhas de importação sem transação vinculada (status pending > 24h)
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const orphanRows = await prisma.importBatchRow.findMany({
    where: {
      status: "pending",
      createdAt: { lt: cutoff },
    },
    select: { id: true, batchId: true, rowIndex: true, createdAt: true },
    take: 20,
  });

  for (const row of orphanRows) {
    issues.push({
      type: "orphan_import_row",
      severity: "warning",
      description: `Linha ${row.rowIndex} do lote ${row.batchId.slice(0, 8)} está pendente há mais de 24h sem confirmação.`,
      affectedId: row.id,
      affectedTable: "ImportBatchRow",
      occurredAt: row.createdAt,
    });
  }

  // 5. Webhooks não processados com mais de 1h
  const webhookCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const failedWebhooks = await prisma.webhookEvent.findMany({
    where: {
      status: { in: ["failed", "pending"] },
      createdAt: { lt: webhookCutoff },
    },
    select: { id: true, source: true, topic: true, status: true, createdAt: true },
    take: 20,
  });

  for (const wh of failedWebhooks) {
    issues.push({
      type: "unprocessed_webhook",
      severity: wh.status === "failed" ? "error" : "warning",
      description: `Webhook ${wh.source}/${wh.topic} com status "${wh.status}" desde ${wh.createdAt.toISOString()}`,
      affectedId: wh.id,
      affectedTable: "WebhookEvent",
      occurredAt: wh.createdAt,
    });
  }

  // Persiste snapshot
  const snapshot = await prisma.reconciliationSnapshot.create({
    data: {
      startDate: start,
      endDate: end,
      issueCount: issues.length,
    },
  });

  return {
    snapshotId: snapshot.id,
    startDate: start,
    endDate: end,
    issueCount: issues.length,
    issues,
    ranAt: snapshot.createdAt,
  };
}
