"use client";

import { useRef, useState } from "react";

import type { ImportBatch, ImportRow } from "@/features/imports/types";

type PreviewData = {
  fileHash: string;
  rows: ImportRow[];
  errorCount: number;
  duplicate: boolean;
  batchId?: string;
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendente",
  committed: "Confirmado",
  rolled_back: "Revertido",
  error: "Erro",
};

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-yellow-50 text-yellow-700",
  committed: "bg-green-50 text-green-700",
  rolled_back: "bg-gray-100 text-gray-500",
  error: "bg-red-50 text-red-600",
};

export default function ImportacoesPage() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [loadingBatches, setLoadingBatches] = useState(false);

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;

    setLoading(true);
    setFeedback(null);
    setPreview(null);
    setBatchId(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("source", "manual");

    const res = await fetch("/api/financial/imports", { method: "POST", body: formData });
    const json = await res.json();
    setLoading(false);

    if (!json.success) {
      setFeedback({ type: "error", message: json.error ?? "Erro ao processar arquivo." });
      return;
    }

    // Busca o batchId pelo hash (precisamos buscar da lista)
    const listRes = await fetch("/api/financial/imports");
    const listJson = await listRes.json();
    const match = listJson.data?.items?.find((b: ImportBatch) => b.fileHash === json.data.fileHash);
    if (match) setBatchId(match.id);

    setPreview({ ...json.data, batchId: match?.id });
  }

  async function handleCommit() {
    if (!batchId) return;
    setLoading(true);
    const res = await fetch("/api/financial/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "commit", batchId }),
    });
    const json = await res.json();
    setLoading(false);
    if (json.success) {
      setFeedback({ type: "success", message: "Importação confirmada com sucesso." });
      setPreview(null);
      setBatchId(null);
    } else {
      setFeedback({ type: "error", message: json.error ?? "Erro ao confirmar." });
    }
  }

  async function handleRollback(id: string) {
    setLoading(true);
    const res = await fetch("/api/financial/imports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "rollback", batchId: id }),
    });
    const json = await res.json();
    setLoading(false);
    if (json.success) {
      setFeedback({ type: "success", message: "Importação revertida." });
      loadBatches();
    } else {
      setFeedback({ type: "error", message: json.error ?? "Erro ao reverter." });
    }
  }

  async function loadBatches() {
    setLoadingBatches(true);
    const res = await fetch("/api/financial/imports");
    const json = await res.json();
    setLoadingBatches(false);
    if (json.success) setBatches(json.data?.items ?? []);
  }

  const pendingRows = preview?.rows.filter((r) => r.status === "pending") ?? [];

  return (
    <div className="max-w-4xl">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Importação de Lançamentos</h1>

      {feedback && (
        <div
          className={`mb-4 rounded-md px-4 py-3 text-sm ${feedback.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}
        >
          {feedback.message}
        </div>
      )}

      {/* Upload */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-medium text-gray-700">Upload CSV</h2>
        <p className="mb-3 text-xs text-gray-500">
          Colunas esperadas: <code className="rounded bg-gray-100 px-1">data, tipo, valor, descricao, categoria, origem</code> — separadas por vírgula ou ponto e vírgula.
        </p>
        <form onSubmit={handleUpload} className="flex items-end gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="block text-sm text-gray-600 file:mr-3 file:rounded file:border file:border-gray-200 file:bg-gray-50 file:px-3 file:py-1.5 file:text-xs"
          />
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {loading ? "Processando..." : "Enviar"}
          </button>
        </form>
      </section>

      {/* Preview */}
      {preview && (
        <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium text-gray-700">
              Preview — {preview.rows.length} linha(s)
              {preview.duplicate && (
                <span className="ml-2 rounded-full bg-yellow-100 px-2 py-0.5 text-xs text-yellow-700">
                  arquivo já importado anteriormente
                </span>
              )}
            </h2>
            {preview.errorCount > 0 && (
              <span className="text-xs text-red-600">{preview.errorCount} erro(s) encontrado(s)</span>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="pb-2 pr-3">#</th>
                  <th className="pb-2 pr-3">Data</th>
                  <th className="pb-2 pr-3">Tipo</th>
                  <th className="pb-2 pr-3">Valor</th>
                  <th className="pb-2 pr-3">Descrição</th>
                  <th className="pb-2 pr-3">Categoria</th>
                  <th className="pb-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowIndex} className="border-b border-gray-50">
                    <td className="py-1.5 pr-3 text-gray-400">{row.rowIndex}</td>
                    <td className="py-1.5 pr-3">
                      {row.status !== "error" ? new Date(row.occurredAt).toLocaleDateString("pt-BR") : "—"}
                    </td>
                    <td className="py-1.5 pr-3">{row.status !== "error" ? (row.type === "income" ? "Entrada" : "Saída") : "—"}</td>
                    <td className="py-1.5 pr-3 font-mono">
                      {row.status !== "error"
                        ? `R$ ${(row.amountCents / 100).toFixed(2).replace(".", ",")}`
                        : "—"}
                    </td>
                    <td className="py-1.5 pr-3 text-gray-600">{row.description ?? "—"}</td>
                    <td className="py-1.5 pr-3 text-gray-600">{row.category ?? "—"}</td>
                    <td className="py-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_COLOR[row.status] ?? ""}`}>
                        {row.errorMsg ?? STATUS_LABEL[row.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pendingRows.length > 0 && batchId && (
            <div className="mt-4 flex gap-3">
              <button
                onClick={handleCommit}
                disabled={loading}
                className="rounded-md bg-green-600 px-4 py-2 text-sm text-white hover:bg-green-700 disabled:opacity-50"
              >
                Confirmar {pendingRows.length} lançamento(s)
              </button>
              <button
                onClick={() => setPreview(null)}
                className="rounded-md border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancelar
              </button>
            </div>
          )}
        </section>
      )}

      {/* Histórico */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700">Histórico de Lotes</h2>
          <button
            onClick={loadBatches}
            disabled={loadingBatches}
            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            {loadingBatches ? "Carregando..." : "Atualizar"}
          </button>
        </div>

        {batches === null ? (
          <p className="text-xs text-gray-400">Clique em &quot;Atualizar&quot; para carregar o histórico.</p>
        ) : batches.length === 0 ? (
          <p className="text-xs text-gray-400">Nenhum lote importado.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="pb-2 pr-3">ID</th>
                <th className="pb-2 pr-3">Origem</th>
                <th className="pb-2 pr-3">Linhas</th>
                <th className="pb-2 pr-3">Erros</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Data</th>
                <th className="pb-2">Ações</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-b border-gray-50">
                  <td className="py-1.5 pr-3 font-mono text-[11px] text-gray-400">{b.id.slice(0, 8)}…</td>
                  <td className="py-1.5 pr-3">{b.source}</td>
                  <td className="py-1.5 pr-3">{b.rowCount}</td>
                  <td className="py-1.5 pr-3 text-red-500">{b.errorCount || "—"}</td>
                  <td className="py-1.5 pr-3">
                    <span className={`rounded-full px-2 py-0.5 ${STATUS_COLOR[b.status] ?? ""}`}>
                      {STATUS_LABEL[b.status] ?? b.status}
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-gray-500">
                    {new Date(b.createdAt).toLocaleDateString("pt-BR")}
                  </td>
                  <td className="py-1.5">
                    {b.status === "committed" && (
                      <button
                        onClick={() => handleRollback(b.id)}
                        className="text-red-500 hover:underline"
                        disabled={loading}
                      >
                        Reverter
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
