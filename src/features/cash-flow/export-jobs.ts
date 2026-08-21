import { randomUUID } from "node:crypto";

import ExcelJS from "exceljs";

import { computeCashFlow } from "@/features/cash-flow/service";
import {
  ensureCashFlowExportJobsTable,
  getCashFlowExportJob,
  getLatestCashFlowExportJobByRequester,
  insertCashFlowExportJob,
  type PersistedCashFlowExportJob,
  updateCashFlowExportJob,
} from "@/features/cash-flow/export-job-repository";
import { formatPaymentMethod, parseOrderNumber } from "@/features/transactions/format";
import { listMarketplaceReadModelPaginated } from "@/features/transactions/read-model";
import { normalizeMarketplaceToken } from "@/features/transactions/read-model-filters";
import {
  PAYMENT_METHODS,
  type FinancialTransaction,
  type PaymentMethod,
} from "@/features/transactions/types";
import { PERIOD_PRESETS, type PeriodPreset } from "@/lib/date-utils";

type CashFlowExportFormat = "csv" | "xlsx";
type CashFlowExportStatus = "queued" | "running" | "completed" | "failed";

type CashFlowExportFilters = {
  preset?: PeriodPreset;
  startDate?: string;
  endDate?: string;
  marketplace?: string;
  paymentMethod?: PaymentMethod;
};

type StartCashFlowExportJobInput = {
  format: CashFlowExportFormat;
  filters: CashFlowExportFilters;
  requestedBy: string | null;
  requestId: string;
};

export type CashFlowExportJob = {
  id: string;
  status: CashFlowExportStatus;
  format: CashFlowExportFormat;
  filters: CashFlowExportFilters;
  searchSummary: {
    marketplace: string;
    periodStart: string;
    periodEnd: string;
    paymentMethod: string;
    preset: string;
  };
  requestedBy: string | null;
  requestId: string | null;
  startedAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  totalRows: number;
  processedRows: number;
  fileName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  lastError: string | null;
  hasFile: boolean;
};

type ExportRow = {
  marketplace: string;
  orderNumber: string;
  date: string;
  paymentMethod: string;
  shipping: string;
  discounts: string;
  fees: string;
  amount: string;
};

const EXPORT_FILE_EXPIRES_DAYS = 1;
const EXPORT_PAGE_SIZE = 200;

function buildSearchSummary(filters: CashFlowExportFilters): CashFlowExportJob["searchSummary"] {
  return {
    marketplace: filters.marketplace ?? "Todos",
    periodStart: filters.startDate ?? "—",
    periodEnd: filters.endDate ?? "—",
    paymentMethod: filters.paymentMethod ?? "Todas",
    preset: filters.preset ?? "Personalizado",
  };
}

/** Aceita `unknown` porque a entrada vem do payload cru do job de exportacao. */
function normalizeMarketplaceFilter(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeMarketplaceToken(value) ?? undefined;
}

function normalizeCashFlowExportFilters(raw: unknown): CashFlowExportFilters {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const presetValue = typeof source.preset === "string" ? source.preset : undefined;
  const preset = PERIOD_PRESETS.includes(presetValue as PeriodPreset)
    ? (presetValue as PeriodPreset)
    : undefined;

  const paymentMethodValue =
    typeof source.paymentMethod === "string" ? source.paymentMethod : undefined;
  const paymentMethod = PAYMENT_METHODS.includes(paymentMethodValue as PaymentMethod)
    ? (paymentMethodValue as PaymentMethod)
    : undefined;

  const startDate =
    typeof source.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.startDate)
      ? source.startDate
      : undefined;
  const endDate =
    typeof source.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.endDate)
      ? source.endDate
      : undefined;
  const marketplace = normalizeMarketplaceFilter(source.marketplace);

  return {
    preset,
    startDate,
    endDate,
    marketplace,
    paymentMethod,
  };
}

function mapPersistedJob(job: PersistedCashFlowExportJob): CashFlowExportJob {
  const filters = normalizeCashFlowExportFilters(job.filters);
  return {
    id: job.id,
    status: job.status,
    format: job.format,
    filters,
    searchSummary: buildSearchSummary(filters),
    requestedBy: job.requested_by,
    requestId: job.request_id,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    expiresAt: job.expires_at,
    totalRows: job.total_rows,
    processedRows: job.processed_rows,
    fileName: job.file_name,
    mimeType: job.mime_type,
    fileSizeBytes: job.file_size_bytes,
    lastError: job.last_error,
    hasFile: Boolean(job.file_data),
  };
}

function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

function mapExportRow(item: FinancialTransaction): ExportRow {
  const occurredAt = new Date(item.occurredAt);

  return {
    marketplace: item.marketplace ?? item.externalSource ?? "—",
    orderNumber: parseOrderNumber(item),
    date: Number.isNaN(occurredAt.getTime())
      ? item.occurredAt
      : occurredAt.toLocaleDateString("pt-BR"),
    paymentMethod: formatPaymentMethod(item),
    shipping: centsToDecimal(item.shippingCents ?? 0),
    discounts: centsToDecimal(item.discountCents ?? 0),
    fees: centsToDecimal((item.taxCents ?? 0) + (item.feeCents ?? 0)),
    amount: centsToDecimal(item.amountCents),
  };
}

function csvEscape(value: string): string {
  if (/[";\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function renderCsv(rows: ExportRow[]): Buffer {
  const headers = [
    "Marketplace",
    "Numero do pedido",
    "Data",
    "Forma de pagamento",
    "Entrega",
    "Descontos",
    "Taxas",
    "Valor",
  ];

  const lines = [headers.join(";")];

  for (const row of rows) {
    lines.push(
      [
        row.marketplace,
        row.orderNumber,
        row.date,
        row.paymentMethod,
        row.shipping,
        row.discounts,
        row.fees,
        row.amount,
      ]
        .map(csvEscape)
        .join(";")
    );
  }

  return Buffer.from(`\uFEFF${lines.join("\n")}`, "utf-8");
}

async function renderXlsx(rows: ExportRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Fluxo de caixa");

  worksheet.columns = [
    { header: "Marketplace", key: "marketplace", width: 20 },
    { header: "Numero do pedido", key: "orderNumber", width: 22 },
    { header: "Data", key: "date", width: 14 },
    { header: "Forma de pagamento", key: "paymentMethod", width: 24 },
    { header: "Entrega", key: "shipping", width: 12 },
    { header: "Descontos", key: "discounts", width: 12 },
    { header: "Taxas", key: "fees", width: 12 },
    { header: "Valor", key: "amount", width: 12 },
  ];

  for (const row of rows) {
    worksheet.addRow(row);
  }

  const binary = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(binary) ? binary : Buffer.from(binary);
}

async function collectRows(
  filters: CashFlowExportFilters,
  onProgress: (processedRows: number) => Promise<void>
): Promise<ExportRow[]> {
  const summary = await computeCashFlow(filters);

  let currentPage = 1;
  let processedRows = 0;
  const rows: ExportRow[] = [];

  while (true) {
    const page = await listMarketplaceReadModelPaginated({
      page: currentPage,
      limit: EXPORT_PAGE_SIZE,
      marketplace: filters.marketplace,
      paymentMethod: filters.paymentMethod,
      startDate: summary.period.startDate,
      endDate: summary.period.endDate,
    });

    for (const item of page.items) {
      rows.push(mapExportRow(item));
      processedRows += 1;
    }

    await onProgress(processedRows);

    if (!page.pagination.hasNext) {
      break;
    }

    currentPage += 1;
  }

  return rows;
}

function buildFileName(format: CashFlowExportFormat): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `fluxo-caixa-${stamp}.${format === "csv" ? "csv" : "xlsx"}`;
}

function addDays(date: Date, days: number): Date {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}

async function executeCashFlowExportJob(jobId: string): Promise<void> {
  const persisted = await getCashFlowExportJob(jobId);
  if (!persisted) return;

  const filters = normalizeCashFlowExportFilters(persisted.filters);

  await updateCashFlowExportJob(jobId, {
    status: "running",
    processed_rows: 0,
    total_rows: 0,
    last_error: null,
  });

  try {
    const rows = await collectRows(filters, async (processedRows) => {
      await updateCashFlowExportJob(jobId, {
        processed_rows: processedRows,
      });
    });

    const fileData =
      persisted.format === "csv" ? renderCsv(rows) : await renderXlsx(rows);

    const mimeType =
      persisted.format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    const now = new Date();

    await updateCashFlowExportJob(jobId, {
      status: "completed",
      processed_rows: rows.length,
      total_rows: rows.length,
      file_data: fileData,
      file_name: buildFileName(persisted.format),
      mime_type: mimeType,
      file_size_bytes: fileData.length,
      finished_at: now.toISOString(),
      expires_at: addDays(now, EXPORT_FILE_EXPIRES_DAYS).toISOString(),
      last_error: null,
    });
  } catch (error) {
    await updateCashFlowExportJob(jobId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      last_error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startCashFlowExportJob(
  input: StartCashFlowExportJobInput
): Promise<CashFlowExportJob> {
  await ensureCashFlowExportJobsTable();

  const running = await getLatestCashFlowExportJobByRequester(input.requestedBy);
  if (running && (running.status === "queued" || running.status === "running")) {
    return mapPersistedJob(running);
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  const persisted: PersistedCashFlowExportJob = {
    id,
    status: "queued",
    format: input.format,
    filters: {
      ...input.filters,
      searchSummary: buildSearchSummary(input.filters),
    },
    requested_by: input.requestedBy,
    request_id: input.requestId,
    started_at: now,
    finished_at: null,
    expires_at: null,
    total_rows: 0,
    processed_rows: 0,
    file_name: null,
    mime_type: null,
    file_data: null,
    file_size_bytes: null,
    last_error: null,
  };

  await insertCashFlowExportJob(persisted);

  void executeCashFlowExportJob(id);

  return mapPersistedJob(persisted);
}

export async function getCashFlowExportJobById(
  jobId: string
): Promise<CashFlowExportJob | null> {
  await ensureCashFlowExportJobsTable();
  const persisted = await getCashFlowExportJob(jobId);
  if (!persisted) return null;
  return mapPersistedJob(persisted);
}

export async function getCurrentCashFlowExportJob(
  requestedBy: string | null
): Promise<CashFlowExportJob | null> {
  await ensureCashFlowExportJobsTable();
  const persisted = await getLatestCashFlowExportJobByRequester(requestedBy);
  if (!persisted) return null;
  return mapPersistedJob(persisted);
}

export async function getCashFlowExportFile(jobId: string): Promise<{
  data: Buffer;
  fileName: string;
  mimeType: string;
  expiresAt: string | null;
  requestedBy: string | null;
} | null> {
  await ensureCashFlowExportJobsTable();
  const persisted = await getCashFlowExportJob(jobId);
  if (!persisted || persisted.status !== "completed" || !persisted.file_data) {
    return null;
  }

  if (persisted.expires_at && new Date(persisted.expires_at).getTime() <= Date.now()) {
    return null;
  }

  return {
    data: persisted.file_data,
    fileName: persisted.file_name ?? buildFileName(persisted.format),
    mimeType:
      persisted.mime_type ??
      (persisted.format === "csv"
        ? "text/csv; charset=utf-8"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    expiresAt: persisted.expires_at,
    requestedBy: persisted.requested_by,
  };
}

export type { CashFlowExportFilters, CashFlowExportFormat, CashFlowExportStatus };