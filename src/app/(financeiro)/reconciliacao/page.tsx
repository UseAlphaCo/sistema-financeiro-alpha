"use client";

import { useState } from "react";

import type { ReconciliationIssue } from "@/features/reconciliation/types";

type Result = {
  snapshotId: string;
  startDate: string;
  endDate: string;
  issueCount: number;
  issues: ReconciliationIssue[];
  ranAt: string;
};

const SEVERITY_COLORS: Record<string, string> = {
  error: "bg-red-50 text-red-700 border-red-100",
  warning: "bg-yellow-50 text-yellow-700 border-yellow-100",
  info: "bg-blue-50 text-blue-600 border-blue-100",
};

const SEVERITY_BADGE: Record<string, string> = {
  error: "bg-red-100 text-red-700",
  warning: "bg-yellow-100 text-yellow-700",
  info: "bg-blue-100 text-blue-600",
};

const TYPE_LABELS: Record<string, string> = {
  duplicate_external_id: "Duplicata",
  missing_category: "Sem categoria",
  negative_balance: "Saldo negativo",
  orphan_import_row: "Importação pendente",
  unprocessed_webhook: "Webhook não processado",
};

const DAY_OPTIONS = [7, 30, 90];

export default function ReconciliacaoPage() {
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setLoading(true);
    setError(null);
    setResult(null);

    const res = await fetch("/api/financial/reconciliation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    });
    const json = await res.json();
    setLoading(false);

    if (!json.success) {
      setError(json.error ?? "Erro ao executar reconciliação.");
      return;
    }
    setResult(json.data);
  }

  const errorIssues = result?.issues.filter((i) => i.severity === "error") ?? [];
  const warningIssues = result?.issues.filter((i) => i.severity === "warning") ?? [];
  const infoIssues = result?.issues.filter((i) => i.severity === "info") ?? [];

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Reconciliação</h1>
          <p className="mt-0.5 text-xs text-gray-500">
            Detecta duplicatas, transações sem categoria, saldo negativo e itens pendentes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {DAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                  days === d
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "border-gray-200 text-gray-500 hover:bg-gray-50"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
          <button
            onClick={handleRun}
            disabled={loading}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {loading ? "Analisando..." : "Executar análise"}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
      )}

      {result && (
        <>
          {/* Resumo */}
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-500">Total de issues</p>
              <p className={`mt-1 text-2xl font-semibold ${result.issueCount > 0 ? "text-red-600" : "text-green-600"}`}>
                {result.issueCount}
              </p>
            </div>
            <div className="rounded-lg border border-red-100 bg-red-50 p-4">
              <p className="text-xs text-red-500">Erros</p>
              <p className="mt-1 text-2xl font-semibold text-red-700">{errorIssues.length}</p>
            </div>
            <div className="rounded-lg border border-yellow-100 bg-yellow-50 p-4">
              <p className="text-xs text-yellow-600">Avisos</p>
              <p className="mt-1 text-2xl font-semibold text-yellow-700">{warningIssues.length}</p>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <p className="text-xs text-gray-400">Executado</p>
              <p className="mt-1 text-xs text-gray-600">
                {new Date(result.ranAt).toLocaleString("pt-BR")}
              </p>
            </div>
          </div>

          {result.issueCount === 0 ? (
            <div className="rounded-lg border border-dashed border-green-200 bg-green-50 p-8 text-center text-sm text-green-700">
              Nenhum problema encontrado no período de {days} dias.
            </div>
          ) : (
            <IssueGroup title="Erros" issues={errorIssues} />
          )}

          <IssueGroup title="Avisos" issues={warningIssues} />
          <IssueGroup title="Informativos" issues={infoIssues} />
        </>
      )}

      {!result && !loading && !error && (
        <div className="rounded-lg border border-dashed border-gray-200 p-10 text-center text-sm text-gray-400">
          Clique em &quot;Executar análise&quot; para iniciar a reconciliação.
        </div>
      )}
    </div>
  );
}

function IssueGroup({ title, issues }: { title: string; issues: ReconciliationIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <section>
      <h2 className="mb-2 text-sm font-medium text-gray-700">
        {title} <span className="text-gray-400">({issues.length})</span>
      </h2>
      <div className="space-y-2">
        {issues.map((issue, i) => (
          <div
            key={i}
            className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${SEVERITY_COLORS[issue.severity] ?? ""}`}
          >
            <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${SEVERITY_BADGE[issue.severity] ?? ""}`}>
              {TYPE_LABELS[issue.type] ?? issue.type}
            </span>
            <span className="flex-1">{issue.description}</span>
            {issue.occurredAt && (
              <span className="shrink-0 text-xs opacity-60">
                {new Date(issue.occurredAt).toLocaleDateString("pt-BR")}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
