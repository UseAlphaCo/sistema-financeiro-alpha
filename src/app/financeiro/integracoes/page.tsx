"use client";

import { useEffect, useState } from "react";

type TransactionItem = {
  id: string;
  externalSource: string | null;
  marketplace: string | null;
  orderNumber: string | null;
  paymentMethodRaw: string | null;
  paymentMethodNormalized:
    | "credit_card"
    | "pix"
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
  if (item.paymentMethodNormalized) {
    return PAYMENT_METHOD_LABELS[item.paymentMethodNormalized];
  }
  if (item.paymentMethodRaw) return item.paymentMethodRaw;
  return "Não informado";
}

export default function IntegracoesPage() {
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [syncDays, setSyncDays] = useState(30);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function loadEvents() {
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
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    setSyncError(null);
    try {
      const res = await fetch("/api/financial/integrations/shopify/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days: syncDays }),
      });
      const json = (await res.json()) as ApiEnvelope<SyncResult>;
      if (json.success && json.data) {
        setSyncResult(json.data);
        void loadEvents();
      } else {
        setSyncError(json.error ?? "Falha na sincronização.");
      }
    } catch {
      setSyncError("Falha ao conectar ao servidor.");
    }
    setSyncing(false);
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadEvents();
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Integrações</h1>
        <p className="mt-1 text-sm text-gray-500">
          Sincronize pedidos da Shopify e veja os eventos recebidos via webhook.
        </p>
      </div>

      {/* Painel de sincronização manual */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-sm font-medium text-gray-700">Sincronizar pedidos da Shopify</h2>
        <p className="mb-4 text-xs text-gray-500">
          Busca pedidos pagos retroativamente via API REST da Shopify. Requer{" "}
          <code className="rounded bg-gray-100 px-1">SHOPIFY_STORE_URL</code> e{" "}
          <code className="rounded bg-gray-100 px-1">SHOPIFY_ACCESS_TOKEN</code> configurados no ambiente.
        </p>

        <div className="flex items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-gray-600">Período</label>
            <select
              value={syncDays}
              onChange={(e) => setSyncDays(Number(e.target.value))}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value={7}>Últimos 7 dias</option>
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
            Sincronização concluída — {syncResult.fetched} pedidos encontrados,{" "}
            <strong>{syncResult.imported} importados</strong>, {syncResult.skipped} já existentes
            {syncResult.failed > 0 && (
              <span className="text-red-600">, {syncResult.failed} com erro</span>
            )}.
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
            Nenhum registro encontrado. Clique em &quot;Sincronizar agora&quot; para importar pedidos existentes.
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
