"use client";

import { useCallback, useEffect, useState } from "react";

type TransactionItem = {
  id: string;
  externalSource: string | null;
  marketplace: string | null;
  orderNumber: string | null;
  paymentMethodRaw: string | null;
  paymentMethodNormalized:
    | "credit_card"
    | "pix"
    | "store_credit"
    | "boleto"
    | "bank_transfer"
    | "wallet"
    | "cash"
    | "other"
    | null;
  amountCents: number;
  occurredAt: string;
  description: string | null;
  source: string;
};

type SyncResult = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  mode: "retroactive";
  estimatedScopeDays: number;
  startedAt: string;
  maxRuns: number;
};

type WorkerSyncStatus = {
  jobId: string;
  status: "queued" | "running" | "completed" | "failed";
  mode: "retroactive";
  estimatedScopeDays: number;
  startedAt: string;
  finishedAt: string | null;
  requestedBy: string | null;
  maxRuns: number;
  runs: number;
  lastError: string | null;
  summary: {
    fetched: number;
    processed: number;
    failed: number;
    skipped: number;
    retried: number;
    deadLettered: number;
    lockSkipped: boolean;
  };
};

type LegacySyncResult = {
  fetched: number;
  imported: number;
  skipped: number;
  failed: number;
};

type ApiEnvelope<T> = { success: boolean; data: T | null; error: string | null };

const PAYMENT_METHOD_LABELS: Record<
  NonNullable<TransactionItem["paymentMethodNormalized"]>,
  string
> = {
  credit_card: "Cartão de crédito",
  pix: "Pix",
  store_credit: "Crédito em loja",
  boleto: "Boleto",
  bank_transfer: "Transferência",
  wallet: "Carteira digital",
  cash: "Dinheiro",
  other: "Outro",
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
  }).format(new Date(iso));
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function parseOrderNumber(item: TransactionItem): string {
  if (item.orderNumber) {
    // Garante prefixo # e exibe todos os dígitos
    const clean = item.orderNumber.replace(/^#/, "");
    return `#${clean}`;
  }
  if (!item.description) return "—";
  const match = item.description.match(/Pedido\s*#\s*([\w-]+)/i);
  return match ? `#${match[1].replace(/^#/, "")}` : "—";
}

function formatPaymentMethod(item: TransactionItem): string {
  if (item.paymentMethodRaw) return item.paymentMethodRaw;
  if (item.paymentMethodNormalized) {
    return PAYMENT_METHOD_LABELS[item.paymentMethodNormalized];
  }
  return "Não informado";
}

export default function IntegracoesPage() {
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [syncDays, setSyncDays] = useState<30 | 60 | 90>(90);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncStatus, setSyncStatus] = useState<WorkerSyncStatus | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      const res = await fetch(
        "/api/financial/transactions?sources=integration,webhook&type=income&limit=50"
      );
      const json = (await res.json()) as ApiEnvelope<{
        items: TransactionItem[];
        pagination: { total: number };
      }>;
      if (json.success && json.data) {
        setItems(json.data.items ?? []);
        setTotal(json.data.pagination?.total ?? 0);
      } else {
        setListError(json.error ?? "Falha ao carregar eventos.");
      }
    } catch {
      setListError("Falha ao conectar ao servidor.");
    }
    setLoadingList(false);
  }, []);

  const loadSyncStatus = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(
        `/api/financial/integrations/worker/status?jobId=${encodeURIComponent(jobId)}`
      );
      const json = (await res.json()) as ApiEnvelope<WorkerSyncStatus>;
      if (!json.success || !json.data) {
        setSyncError(json.error ?? "Falha ao consultar status do job.");
        return;
      }

      setSyncStatus(json.data);

      if (json.data.status === "completed") {
        void loadEvents();
      }
    } catch {
      setSyncError("Falha ao consultar status do job.");
    }
  }, [loadEvents]);

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    setSyncStatus(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/financial/integrations/worker/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "retroactive",
          days: syncDays,
        }),
      });
      const json = (await res.json()) as ApiEnvelope<SyncResult | LegacySyncResult>;
      if (json.success && json.data) {
        const started = json.data as SyncResult;
        if (!started.jobId) {
          setSyncError("Resposta invalida ao iniciar sincronizacao do worker.");
        } else {
          setSyncResult(started);
          void loadSyncStatus(started.jobId);
        }
      } else {
        setSyncError(json.error ?? "Falha na sincronização.");
      }
    } catch {
      setSyncError("Falha ao conectar ao servidor.");
    }
    setSyncing(false);
  }

  useEffect(() => {
    if (!syncResult?.jobId) return;

    if (syncStatus?.status === "completed" || syncStatus?.status === "failed") {
      return;
    }

    const intervalId = setInterval(() => {
      void loadSyncStatus(syncResult.jobId);
    }, 1500);

    return () => clearInterval(intervalId);
  }, [loadSyncStatus, syncResult?.jobId, syncStatus?.status]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadEvents();
    }, 0);

    return () => clearTimeout(timer);
  }, [loadEvents]);

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Integrações</h1>
        <p className="mt-1 text-sm text-gray-500">
          Dispare o Worker ALP-OMS para carregar retroativo e acompanhe o progresso da sincronizacao.
        </p>
      </div>

      {/* Painel de sincronização manual */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-medium text-gray-700">Sincronizar retroativo ALP-OMS (Worker)</h2>
        <p className="mb-4 text-xs text-gray-500">
          Executa o pipeline oficial OMS {'->'} sync_events {'->'} Worker {'->'} mirror.raw_payloads.
          Escopo inicial desta rodada: 90 dias retroativos.
        </p>

        <div className="flex items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-gray-600">Período</label>
            <select
              value={syncDays}
              onChange={(e) => setSyncDays(Number(e.target.value) as 30 | 60 | 90)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value={30}>Últimos 30 dias</option>
              <option value={60}>Últimos 60 dias</option>
              <option value={90}>Últimos 90 dias</option>
            </select>
          </div>

          <button
            onClick={() => void handleSync()}
            disabled={syncing}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
          >
            {syncing ? "Sincronizando..." : "Sincronizar agora"}
          </button>
        </div>

        {syncResult && (
          <div className="mt-4 rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
            Job iniciado — ID <strong>{syncResult.jobId}</strong>, status inicial {syncResult.status},
            escopo estimado de {syncResult.estimatedScopeDays} dias.
          </div>
        )}

        {syncStatus && (
          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <div>
              Status: <strong>{syncStatus.status}</strong> | Ciclos: {syncStatus.runs}/{syncStatus.maxRuns}
            </div>
            <div className="mt-1 text-xs text-blue-800">
              fetched={syncStatus.summary.fetched} processed={syncStatus.summary.processed} failed={syncStatus.summary.failed} skipped={syncStatus.summary.skipped} retried={syncStatus.summary.retried} deadLettered={syncStatus.summary.deadLettered}
            </div>
            {syncStatus.lastError && (
              <div className="mt-1 text-xs text-red-700">Ultimo erro: {syncStatus.lastError}</div>
            )}
          </div>
        )}

        {syncError && (
          <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {syncError}
          </div>
        )}
      </section>

      {/* Lista de transações vindas de webhook/integração */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700">Transações importadas via integração</h2>
          <button
            onClick={() => void loadEvents()}
            disabled={loadingList}
            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            {loadingList ? "Carregando..." : "Atualizar"}
          </button>
        </div>

        {listError && (
          <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {listError}
          </div>
        )}

        {items.length === 0 && !loadingList ? (
          <div className="rounded-md border border-dashed border-gray-300 py-16 text-center text-sm text-gray-500">
            Nenhum registro encontrado. Clique em &quot;Sincronizar agora&quot; para executar o retroativo via Worker.
          </div>
        ) : (
          <>
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Marketplace</th>
                    <th className="px-4 py-3 text-left">Número do pedido</th>
                    <th className="px-4 py-3 text-left">Data</th>
                    <th className="px-4 py-3 text-left">Forma de pagamento</th>
                    <th className="px-4 py-3 text-right">Valor</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((item) => (
                    <tr key={item.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600 capitalize">
                        {item.marketplace ?? item.externalSource ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-900">
                        {parseOrderNumber(item)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                        {formatDate(item.occurredAt)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                        {formatPaymentMethod(item)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right font-medium text-green-700">
                        {formatCurrency(item.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-gray-400">Exibindo {items.length} de {total} registros</p>
          </>
        )}
      </section>
    </div>
  );
}
