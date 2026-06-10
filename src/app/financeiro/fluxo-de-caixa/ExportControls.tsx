"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ExportFormat = "csv" | "xlsx";
type ExportStatus = "queued" | "running" | "completed" | "failed";

type ExportFilters = {
  preset?: string;
  startDate?: string;
  endDate?: string;
  marketplace?: string;
  paymentMethod?: string;
};

type ExportJob = {
  jobId: string;
  status: ExportStatus;
  format: ExportFormat;
  startedAt: string;
  finishedAt: string | null;
  processedRows: number;
  totalRows: number;
  expiresAt: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  lastError: string | null;
  canDownload: boolean;
  searchSummary: {
    marketplace: string;
    periodStart: string;
    periodEnd: string;
    paymentMethod: string;
    preset: string;
  };
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

type Props = {
  filters: ExportFilters;
};

function formatDateTime(value: string | null): string {
  if (!value) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("pt-BR");
}

function formatBytes(value: number | null): string {
  if (!value || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function statusLabel(status: ExportStatus): string {
  switch (status) {
    case "queued":
      return "Na fila";
    case "running":
      return "Processando";
    case "completed":
      return "Concluído";
    case "failed":
      return "Falhou";
    default:
      return status;
  }
}

function formatSummaryValue(value: string): string {
  return value || "—";
}

export default function ExportControls({ filters }: Props) {
  const [starting, setStarting] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canStart = !starting && job?.status !== "queued" && job?.status !== "running";

  const payloadFilters = useMemo(
    () => ({
      preset: filters.preset,
      startDate: filters.startDate,
      endDate: filters.endDate,
      marketplace: filters.marketplace,
      paymentMethod: filters.paymentMethod,
    }),
    [
      filters.endDate,
      filters.marketplace,
      filters.paymentMethod,
      filters.preset,
      filters.startDate,
    ]
  );

  const loadStatus = useCallback(async (jobId?: string) => {
    const url = jobId
      ? `/api/financial/cash-flow/export/status?jobId=${encodeURIComponent(jobId)}`
      : "/api/financial/cash-flow/export/status";

    const response = await fetch(url, { method: "GET", cache: "no-store" });
    if (response.status === 404) {
      if (!jobId) {
        setJob(null);
        setActiveJobId(null);
        setError(null);
      }
      return;
    }

    const json = (await response.json()) as ApiEnvelope<ExportJob>;
    if (!json.success || !json.data) {
      setError(json.error ?? "Falha ao consultar exportação.");
      return;
    }

    setError(null);
    setJob(json.data);
    setActiveJobId(json.data.jobId);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadStatus();
    }, 0);

    return () => clearTimeout(timer);
  }, [loadStatus]);

  useEffect(() => {
    if (!activeJobId) return;
    if (job?.status === "completed" || job?.status === "failed") return;

    const intervalId = setInterval(() => {
      void loadStatus(activeJobId);
    }, 1500);

    return () => clearInterval(intervalId);
  }, [activeJobId, job?.status, loadStatus]);

  async function startExport(format: ExportFormat) {
    setStarting(true);
    setError(null);

    try {
      const response = await fetch("/api/financial/cash-flow/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          format,
          filters: payloadFilters,
        }),
      });

      const json = (await response.json()) as ApiEnvelope<{
        jobId: string;
        status: ExportStatus;
        format: ExportFormat;
        startedAt: string;
        processedRows: number;
        totalRows: number;
      }>;

      if (!json.success || !json.data) {
        setError(json.error ?? "Falha ao iniciar exportação.");
        return;
      }

      setActiveJobId(json.data.jobId);
      await loadStatus(json.data.jobId);
    } catch {
      setError("Falha de rede ao iniciar exportação.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void startExport("csv")}
          disabled={!canStart}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Exportar CSV (todos filtros)
        </button>

        <button
          type="button"
          onClick={() => void startExport("xlsx")}
          disabled={!canStart}
          className="rounded-md bg-gray-900 px-3 py-2 text-sm text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Exportar XLSX (todos filtros)
        </button>
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      {job ? (
        <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          <div className="mb-2 rounded border border-gray-200 bg-white p-2 text-[11px] text-gray-700">
            <p className="font-semibold text-gray-800">Resumo da busca exportada</p>
            <p>
              Marketplace: <strong>{formatSummaryValue(job.searchSummary.marketplace)}</strong>
            </p>
            <p>
              Período: <strong>{formatSummaryValue(job.searchSummary.periodStart)} a {formatSummaryValue(job.searchSummary.periodEnd)}</strong>
            </p>
            <p>
              Forma de pagamento: <strong>{formatSummaryValue(job.searchSummary.paymentMethod)}</strong>
            </p>
            <p>
              Preset: <strong>{formatSummaryValue(job.searchSummary.preset)}</strong>
            </p>
          </div>
          <p>
            Status: <strong>{statusLabel(job.status)}</strong>
          </p>
          <p>
            Formato: <strong>{job.format.toUpperCase()}</strong>
          </p>
          <p>
            Processadas: <strong>{job.processedRows}</strong>
            {job.totalRows > 0 ? ` de ${job.totalRows}` : ""}
          </p>
          <p>
            Início: <strong>{formatDateTime(job.startedAt)}</strong>
          </p>
          <p>
            Fim: <strong>{formatDateTime(job.finishedAt)}</strong>
          </p>
          <p>
            Tamanho: <strong>{formatBytes(job.fileSizeBytes)}</strong>
          </p>
          {job.lastError ? (
            <p className="text-red-600">
              Erro: <strong>{job.lastError}</strong>
            </p>
          ) : null}

          {job.canDownload ? (
            <div className="mt-2">
              <a
                href={`/api/financial/cash-flow/export/download?jobId=${encodeURIComponent(job.jobId)}`}
                className="inline-flex rounded-md border border-green-600 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-50"
              >
                Baixar arquivo
              </a>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
