import type { Prisma } from "@prisma/client";
import { getPrismaClient } from "@/core/db/prisma-client";
import type { ImportBatch, ImportRow } from "./types";

const prisma = getPrismaClient();

function mapBatch(raw: {
  id: string;
  source: string;
  fileHash: string;
  status: string;
  rowCount: number;
  errorCount: number;
  createdAt: Date;
}): ImportBatch {
  return {
    id: raw.id,
    source: raw.source,
    fileHash: raw.fileHash,
    status: raw.status as ImportBatch["status"],
    rowCount: raw.rowCount,
    errorCount: raw.errorCount,
    createdAt: raw.createdAt,
  };
}

function mapRow(raw: {
  id: string;
  batchId: string;
  rowIndex: number;
  occurredAt: Date;
  type: string;
  amountCents: number;
  description: string | null;
  category: string | null;
  source: string | null;
  status: string;
  errorMsg: string | null;
}): ImportRow {
  return {
    rowIndex: raw.rowIndex,
    occurredAt: raw.occurredAt,
    type: raw.type as ImportRow["type"],
    amountCents: raw.amountCents,
    description: raw.description ?? undefined,
    category: raw.category ?? undefined,
    source: raw.source ?? undefined,
    status: raw.status as ImportRow["status"],
    errorMsg: raw.errorMsg ?? undefined,
  };
}

export async function findBatchByHash(fileHash: string): Promise<ImportBatch | null> {
  const row = await prisma.importBatch.findUnique({ where: { fileHash } });
  return row ? mapBatch(row) : null;
}

export async function listBatches(): Promise<ImportBatch[]> {
  const rows = await prisma.importBatch.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map(mapBatch);
}

export async function createBatch(
  data: { source: string; fileHash: string; rows: ImportRow[] },
): Promise<ImportBatch> {
  const errorCount = data.rows.filter((r) => r.status === "error").length;

  const batch = await prisma.importBatch.create({
    data: {
      source: data.source,
      fileHash: data.fileHash,
      status: "pending",
      rowCount: data.rows.length,
      errorCount,
      rows: {
        create: data.rows.map((r) => ({
          rowIndex: r.rowIndex,
          occurredAt: r.occurredAt,
          type: r.type,
          amountCents: r.amountCents,
          description: r.description ?? null,
          category: r.category ?? null,
          source: r.source ?? null,
          status: r.status,
          errorMsg: r.errorMsg ?? null,
        })),
      },
    },
  });

  return mapBatch(batch);
}

export async function getBatchWithRows(batchId: string): Promise<(ImportBatch & { rows: ImportRow[] }) | null> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { orderBy: { rowIndex: "asc" } } },
  });
  if (!batch) return null;
  return { ...mapBatch(batch), rows: batch.rows.map(mapRow) };
}

export async function commitBatch(batchId: string, userId: string): Promise<void> {
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { rows: { where: { status: "pending" } } },
  });
  if (!batch || batch.status !== "pending") {
    throw new Error("Lote não encontrado ou já processado.");
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    for (const row of batch.rows) {
      await tx.financialTransaction.create({
        data: {
          type: row.type,
          amountCents: row.amountCents,
          currency: "BRL",
          occurredAt: row.occurredAt,
          description: row.description,
          source: "import",
          status: "applied",
          createdBy: userId,
          externalSource: `import:${batchId}`,
          externalId: `row:${row.rowIndex}`,
        },
      });
      await tx.importBatchRow.update({
        where: { id: row.id },
        data: { status: "committed" },
      });
    }
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: "committed" },
    });
  });
}

export async function rollbackBatch(batchId: string): Promise<void> {
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } });
  if (!batch || batch.status !== "committed") {
    throw new Error("Lote não encontrado ou não está no estado 'committed'.");
  }

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.financialTransaction.deleteMany({
      where: { externalSource: `import:${batchId}` },
    });
    await tx.importBatchRow.updateMany({
      where: { batchId },
      data: { status: "pending" },
    });
    await tx.importBatch.update({
      where: { id: batchId },
      data: { status: "rolled_back" },
    });
  });
}
