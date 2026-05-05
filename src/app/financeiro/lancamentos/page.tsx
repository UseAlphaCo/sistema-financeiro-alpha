"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type TransactionItem = {
  id: string;
  type: "income" | "expense" | "transfer";
  amountCents: number;
  occurredAt: string;
  description: string | null;
  source: string;
  status: string;
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
};

type EditingState = {
  id: string;
  date: string;
  amount: string;
  description: string;
};

function formatBRL(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(iso));
}

function parseCurrencyToCents(value: string): number {
  const normalized = value.replace(/\./g, "").replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.round(parsed * 100);
}

function centsToInputValue(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

export default function LancamentosPage() {
  const [type, setType] = useState<"income" | "expense">("income");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const amountCents = useMemo(() => {
    return parseCurrencyToCents(amount);
  }, [amount]);

  async function loadManualTransactions() {
    setLoadingList(true);
    const res = await fetch("/api/financial/transactions?source=manual&limit=20", {
      method: "GET",
      cache: "no-store",
    });

    const json = (await res.json()) as ApiEnvelope<{
      items: TransactionItem[];
    }>;

    setLoadingList(false);

    if (!json.success || !json.data) {
      setFeedback({ type: "error", message: json.error ?? "Falha ao carregar lançamentos." });
      return;
    }

    setItems(json.data.items);
  }

  useEffect(() => {
    void loadManualTransactions();
  }, []);

  function startEditing(item: TransactionItem) {
    setEditing({
      id: item.id,
      date: item.occurredAt.slice(0, 10),
      amount: centsToInputValue(item.amountCents),
      description: item.description ?? "",
    });
    setFeedback(null);
  }

  function cancelEditing() {
    setEditing(null);
  }

  async function handleUpdate() {
    if (!editing) return;

    const nextAmountCents = parseCurrencyToCents(editing.amount);
    if (!nextAmountCents) {
      setFeedback({ type: "error", message: "Informe um valor válido para editar." });
      return;
    }

    const occurredAt = new Date(`${editing.date}T12:00:00`).toISOString();
    setSavingEdit(true);

    const res = await fetch("/api/financial/transactions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: editing.id,
        amountCents: nextAmountCents,
        occurredAt,
        description: editing.description.trim() || null,
        changeReason: "edicao manual via painel",
      }),
    });

    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    setSavingEdit(false);

    if (!json.success) {
      setFeedback({ type: "error", message: json.error ?? "Falha ao atualizar lançamento." });
      return;
    }

    setFeedback({ type: "success", message: "Lançamento atualizado com sucesso." });
    setEditing(null);
    await loadManualTransactions();
  }

  async function handleDelete(id: string) {
    const confirmed = window.confirm("Deseja realmente excluir este lançamento?");
    if (!confirmed) return;

    setDeletingId(id);
    const res = await fetch("/api/financial/transactions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        changeReason: "exclusao manual via painel",
      }),
    });

    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    setDeletingId(null);

    if (!json.success) {
      setFeedback({ type: "error", message: json.error ?? "Falha ao excluir lançamento." });
      return;
    }

    if (editing?.id === id) setEditing(null);
    setFeedback({ type: "success", message: "Lançamento excluído com sucesso." });
    await loadManualTransactions();
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFeedback(null);

    if (!amountCents) {
      setFeedback({ type: "error", message: "Informe um valor válido." });
      return;
    }

    setLoading(true);

    const occurredAt = new Date(`${date}T12:00:00`).toISOString();

    const res = await fetch("/api/financial/transactions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type,
        amountCents,
        occurredAt,
        description: description.trim() || undefined,
        source: "manual",
        status: "approved",
      }),
    });

    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    setLoading(false);

    if (!json.success) {
      setFeedback({ type: "error", message: json.error ?? "Falha ao salvar lançamento." });
      return;
    }

    setFeedback({ type: "success", message: "Lançamento salvo com sucesso." });
    setAmount("");
    setDescription("");
    await loadManualTransactions();
  }

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold text-gray-900">Lançamentos Manuais</h1>
        <p className="mt-1 text-sm text-gray-500">Cadastre entradas e saídas sem depender da integração.</p>
      </div>

      {feedback && (
        <div
          className={`mb-4 rounded-md px-4 py-3 text-sm ${
            feedback.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
          }`}
        >
          {feedback.message}
        </div>
      )}

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-sm font-medium text-gray-700">Novo lançamento</h2>

        <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm text-gray-600">Tipo</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as "income" | "expense")}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="income">Entrada</option>
              <option value="expense">Saída</option>
            </select>
          </div>

          <div>
            <label className="mb-1 block text-sm text-gray-600">Data</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-gray-600">Valor (R$)</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
              required
            />
          </div>

          <div>
            <label className="mb-1 block text-sm text-gray-600">Descrição</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Ex.: Recebimento de cliente"
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
          </div>

          <div className="sm:col-span-2">
            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
            >
              {loading ? "Salvando..." : "Salvar lançamento"}
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700">Últimos lançamentos manuais</h2>
          <button
            onClick={() => void loadManualTransactions()}
            disabled={loadingList}
            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            {loadingList ? "Carregando..." : "Atualizar"}
          </button>
        </div>

        {items.length === 0 ? (
          <p className="text-sm text-gray-500">Nenhum lançamento manual cadastrado ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="px-2 py-2">Data</th>
                  <th className="px-2 py-2">Tipo</th>
                  <th className="px-2 py-2">Descrição</th>
                  <th className="px-2 py-2 text-right">Valor</th>
                  <th className="px-2 py-2 text-right">Ações</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-gray-100">
                    <td className="px-2 py-2 text-gray-600">
                      {editing?.id === item.id ? (
                        <input
                          type="date"
                          value={editing.date}
                          onChange={(e) => setEditing({ ...editing, date: e.target.value })}
                          className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs"
                        />
                      ) : (
                        formatDate(item.occurredAt)
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          item.type === "income"
                            ? "bg-green-100 text-green-700"
                            : "bg-red-100 text-red-700"
                        }`}
                      >
                        {item.type === "income" ? "Entrada" : "Saída"}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-gray-700">
                      {editing?.id === item.id ? (
                        <input
                          type="text"
                          value={editing.description}
                          onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                          className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs"
                          placeholder="Descrição"
                        />
                      ) : (
                        item.description ?? "—"
                      )}
                    </td>
                    <td
                      className={`px-2 py-2 text-right font-medium ${
                        item.type === "income" ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {editing?.id === item.id ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={editing.amount}
                          onChange={(e) => setEditing({ ...editing, amount: e.target.value })}
                          className="w-28 rounded-md border border-gray-300 px-2 py-1 text-right text-xs"
                          placeholder="0,00"
                        />
                      ) : (
                        formatBRL(item.amountCents)
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {editing?.id === item.id ? (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => void handleUpdate()}
                            disabled={savingEdit}
                            className="rounded-md bg-gray-900 px-2.5 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-50"
                          >
                            {savingEdit ? "Salvando..." : "Salvar"}
                          </button>
                          <button
                            onClick={cancelEditing}
                            disabled={savingEdit}
                            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => startEditing(item)}
                            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => void handleDelete(item.id)}
                            disabled={deletingId === item.id}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
                          >
                            {deletingId === item.id ? "Excluindo..." : "Excluir"}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
