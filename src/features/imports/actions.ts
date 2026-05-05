"use server";

import { createHash } from "crypto";
import { z } from "zod";

import type { ActionResult } from "@/types/api";
import { parseCsv } from "./csv-parser";
import * as repo from "./repository";
import type { ImportBatch, ImportRow } from "./types";

// ─── Preview ─────────────────────────────────────────────────────────────────

const PreviewSchema = z.object({
  csvContent: z.string().min(1),
  source: z.string().optional(),
});

export async function previewImportAction(input: {
  csvContent: string;
  source?: string;
}): Promise<ActionResult<{ fileHash: string; rows: ImportRow[]; errorCount: number; duplicate: boolean }>> {
  const parsed = PreviewSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  const { csvContent, source } = parsed.data;
  const fileHash = createHash("sha256").update(csvContent).digest("hex");

  const existing = await repo.findBatchByHash(fileHash);
  if (existing) {
    const withRows = await repo.getBatchWithRows(existing.id);
    return {
      success: true,
      data: {
        fileHash,
        rows: withRows?.rows ?? [],
        errorCount: existing.errorCount,
        duplicate: true,
      },
    };
  }

  const { rows, errorCount } = parseCsv(csvContent);

  // Persiste como lote pendente
  await repo.createBatch({ source: source ?? "manual", fileHash, rows });

  return { success: true, data: { fileHash, rows, errorCount, duplicate: false } };
}

// ─── Commit ───────────────────────────────────────────────────────────────────

const CommitSchema = z.object({
  batchId: z.string().min(1),
  userId: z.string().min(1),
});

export async function commitImportAction(input: {
  batchId: string;
  userId: string;
}): Promise<ActionResult<{ batchId: string }>> {
  const parsed = CommitSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  try {
    await repo.commitBatch(parsed.data.batchId, parsed.data.userId);
    return { success: true, data: { batchId: parsed.data.batchId } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Erro ao confirmar importação." };
  }
}

// ─── Rollback ─────────────────────────────────────────────────────────────────

const RollbackSchema = z.object({
  batchId: z.string().min(1),
});

export async function rollbackImportAction(input: {
  batchId: string;
}): Promise<ActionResult<{ batchId: string }>> {
  const parsed = RollbackSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: parsed.error.errors[0].message };
  }

  try {
    await repo.rollbackBatch(parsed.data.batchId);
    return { success: true, data: { batchId: parsed.data.batchId } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Erro ao reverter importação." };
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listImportBatchesAction(): Promise<ActionResult<ImportBatch[]>> {
  try {
    const batches = await repo.listBatches();
    return { success: true, data: batches };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Erro ao listar importações." };
  }
}
