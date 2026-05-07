"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type TransactionType = "income" | "expense" | "transfer";
type CategoryDirection = "entrada" | "saida";

type TransactionItem = {
  id: string;
  type: TransactionType;
  categoryId: string | null;
  amountCents: number;
  occurredAt: string;
  description: string | null;
  source: string;
  status: string;
};

type CategoryItem = {
  id: string;
  name: string;
  direction: CategoryDirection;
  color: string | null;
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
  requestId: string;
  meta: Record<string, unknown>;
};

type EditingState = {
  id: string;
  date: string;
  categoryId: string;
  amount: string;
  description: string;
};

type CategoryDraft = {
  name: string;
  direction: CategoryDirection;
  color: string;
};

const FALLBACK_COLORS = ["#0f766e", "#1d4ed8", "#b45309", "#7c3aed", "#be123c", "#0369a1"];

function formatBRL(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function formatDate(iso: string) {
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));
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

function typeToDirection(type: TransactionType): CategoryDirection | null {
  if (type === "income") return "entrada";
  if (type === "expense") return "saida";
  return null;
}

function normalizeColor(color?: string | null) {
  if (!color) return "#6b7280";
  return /^#([0-9A-Fa-f]{6})$/.test(color) ? color : "#6b7280";
}

export function LancamentosContent() {
  const [type, setType] = useState<"income" | "expense">("income");
  const [categoryId, setCategoryId] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<TransactionItem[]>([]);
  const [categories, setCategories] = useState<CategoryItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, CategoryDraft>>({});
  const [categoryFilterId, setCategoryFilterId] = useState("");
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [savingCategoryId, setSavingCategoryId] = useState<string | null>(null);
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [newCategoryDirection, setNewCategoryDirection] = useState<CategoryDirection>("entrada");
  const [newCategoryColor, setNewCategoryColor] = useState("#0f766e");
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const amountCents = useMemo(() => parseCurrencyToCents(amount), [amount]);

  const categoriesMap = useMemo(() => {
    const map = new Map<string, CategoryItem>();
    for (const category of categories) map.set(category.id, category);
    return map;
  }, [categories]);

  const categoriesForType = useMemo(() => {
    const direction = typeToDirection(type);
    return categories.filter((item) => item.direction === direction);
  }, [categories, type]);

  const displayedItems = useMemo(() => {
    if (!categoryFilterId) return items;
    return items.filter((item) => item.categoryId === categoryFilterId);
  }, [items, categoryFilterId]);

  const chartData = useMemo(() => {
    const map = new Map<string, { id: string; name: string; color: string; total: number }>();

    for (const item of displayedItems) {
      if (!item.categoryId) continue;

      const category = categoriesMap.get(item.categoryId);
      const existing = map.get(item.categoryId);
      const fallback = FALLBACK_COLORS[map.size % FALLBACK_COLORS.length];
      const color = normalizeColor(category?.color ?? fallback);

      if (!existing) {
        map.set(item.categoryId, {
          id: item.categoryId,
          name: category?.name ?? "Sem categoria",
          color,
          total: item.amountCents,
        });
      } else {
        existing.total += item.amountCents;
      }
    }

    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [displayedItems, categoriesMap]);

  const chartTotal = useMemo(() => chartData.reduce((sum, item) => sum + item.total, 0), [chartData]);

  const chartBackground = useMemo(() => {
    if (chartData.length === 0 || chartTotal <= 0) {
      return "conic-gradient(#e5e7eb 0deg 360deg)";
    }

    let current = 0;
    const parts: string[] = [];
    for (const item of chartData) {
      const end = current + (item.total / chartTotal) * 360;
      parts.push(`${item.color} ${current.toFixed(2)}deg ${end.toFixed(2)}deg`);
      current = end;
    }
    return `conic-gradient(${parts.join(", ")})`;
  }, [chartData, chartTotal]);

  async function loadCategories() {
    const res = await fetch("/api/financial/categories", { cache: "no-store" });
    const json = (await res.json()) as ApiEnvelope<CategoryItem[]>;

    if (!json.success || !json.data) {
      setFeedback({ type: "error", message: json.error ?? "Falha ao carregar categorias." });
      return;
    }

    setCategories(json.data);
    setDrafts(
      Object.fromEntries(
        json.data.map((item) => [
          item.id,
          { name: item.name, direction: item.direction, color: normalizeColor(item.color) },
        ])
      )
    );
  }

  const loadTransactions = useCallback(async () => {
    setLoadingList(true);
    const params = new URLSearchParams({ source: "manual", limit: "100" });
    if (categoryFilterId) params.set("categoryId", categoryFilterId);

    const res = await fetch(`/api/financial/transactions?${params.toString()}`, { cache: "no-store" });
    const json = (await res.json()) as ApiEnvelope<{ items: TransactionItem[] }>;
    setLoadingList(false);

    if (!json.success || !json.data) {
      setFeedback({ type: "error", message: json.error ?? "Falha ao carregar lançamentos." });
      return;
    }

    setItems(json.data.items);
  }, [categoryFilterId]);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadCategories();
    }, 0);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadTransactions();
    }, 0);

    return () => clearTimeout(timer);
  }, [loadTransactions]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!amountCents) return setFeedback({ type: "error", message: "Informe um valor válido." });
    if (!categoryId) return setFeedback({ type: "error", message: "Selecione uma categoria." });

    setLoading(true);
    const occurredAt = new Date(`${date}T12:00:00`).toISOString();
    const res = await fetch("/api/financial/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, categoryId, amountCents, occurredAt, description, source: "manual", status: "approved" }),
    });
    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    setLoading(false);

    if (!json.success) return setFeedback({ type: "error", message: json.error ?? "Falha ao salvar." });

    setAmount("");
    setDescription("");
    setFeedback({ type: "success", message: "Lançamento salvo com sucesso." });
    await loadTransactions();
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Deseja excluir este lançamento?")) return;
    setDeletingId(id);
    const res = await fetch("/api/financial/transactions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, changeReason: "exclusao manual via painel" }),
    });
    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    setDeletingId(null);

    if (!json.success) return setFeedback({ type: "error", message: json.error ?? "Falha ao excluir." });

    await loadTransactions();
  }

  async function handleCreateCategory(event: FormEvent) {
    event.preventDefault();
    const res = await fetch("/api/financial/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCategoryName, direction: newCategoryDirection, color: newCategoryColor }),
    });
    const json = (await res.json()) as ApiEnvelope<CategoryItem>;
    if (!json.success) return setFeedback({ type: "error", message: json.error ?? "Falha ao criar categoria." });

    setNewCategoryName("");
    setFeedback({ type: "success", message: "Categoria criada com sucesso." });
    await loadCategories();
  }

  async function handleUpdateCategory(id: string) {
    const draft = drafts[id];
    if (!draft) return;
    setSavingCategoryId(id);
    const res = await fetch(`/api/financial/categories/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(draft),
    });
    const json = (await res.json()) as ApiEnvelope<CategoryItem>;
    setSavingCategoryId(null);
    if (!json.success) return setFeedback({ type: "error", message: json.error ?? "Falha ao atualizar categoria." });

    await loadCategories();
  }

  async function handleDeleteCategory(id: string) {
    if (!window.confirm("Deseja excluir esta categoria?")) return;
    setDeletingCategoryId(id);
    const res = await fetch(`/api/financial/categories/${id}`, { method: "DELETE" });
    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    setDeletingCategoryId(null);
    if (!json.success) return setFeedback({ type: "error", message: json.error ?? "Falha ao excluir categoria." });

    await loadCategories();
    await loadTransactions();
  }

  return (
    <div className="space-y-8">
      {feedback && <div className={`rounded-md px-4 py-3 text-sm ${feedback.type === "success" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>{feedback.message}</div>}

      {/* CRUD de categorias removido. A gestão de categorias agora é feita em sub-menu próprio. */}


      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Coluna 1: Novo lançamento */}
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium text-gray-700">Novo lançamento</h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3">
            <select value={type} onChange={(event) => setType(event.target.value as "income" | "expense")} className="rounded-md border border-gray-300 px-3 py-2 text-sm"><option value="income">Entrada</option><option value="expense">Saída</option></select>
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} className="rounded-md border border-gray-300 px-3 py-2 text-sm" required><option value="">Selecione a categoria</option>{categoriesForType.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-md border border-gray-300 px-3 py-2 text-sm" required />
            <input type="text" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0,00" className="rounded-md border border-gray-300 px-3 py-2 text-sm" required />
            <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Descrição" className="rounded-md border border-gray-300 px-3 py-2 text-sm" />
            <button type="submit" disabled={loading} className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700">{loading ? "Salvando..." : "Salvar lançamento"}</button>
          </form>
        </div>
        {/* Coluna 2: Gráficos */}
        <div className="space-y-6">
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-medium text-gray-700">Distribuição por categoria</h2>
            <div className="flex items-center gap-6">
              <div className="h-40 w-40 rounded-full border border-gray-200" style={{ background: chartBackground }} />
              <div className="space-y-2 text-sm">{chartData.length === 0 ? <p className="text-gray-500">Sem dados.</p> : chartData.map((item) => <div key={item.id} className="flex items-center gap-2"><span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: item.color }} /> <span>{item.name}</span><span className="text-gray-500">{((item.total / chartTotal) * 100).toFixed(1)}%</span></div>)}</div>
            </div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-sm font-medium text-gray-700">Quantitativo por categoria</h2>
            <div className="space-y-2">{chartData.length === 0 ? <p className="text-sm text-gray-500">Sem dados.</p> : chartData.map((item) => <div key={item.id}><div className="mb-1 flex justify-between text-xs text-gray-600"><span>{item.name}</span><span>{formatBRL(item.total)}</span></div><div className="h-2 rounded-full bg-gray-100"><div className="h-2 rounded-full" style={{ width: `${Math.max((item.total / chartTotal) * 100, 2)}%`, backgroundColor: item.color }} /></div></div>)}</div>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-700">Lançamentos manuais</h2>
          <div className="flex items-center gap-2"><select value={categoryFilterId} onChange={(event) => setCategoryFilterId(event.target.value)} className="rounded-md border border-gray-300 px-2 py-1 text-xs"><option value="">Todas categorias</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => void loadTransactions()} disabled={loadingList} className="text-xs text-gray-500">{loadingList ? "Carregando..." : "Atualizar"}</button></div>
        </div>

        {displayedItems.length === 0 ? <p className="text-sm text-gray-500">Nenhum lançamento.</p> : <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500"><th className="px-2 py-2">Data</th><th className="px-2 py-2">Tipo</th><th className="px-2 py-2">Categoria</th><th className="px-2 py-2">Descrição</th><th className="px-2 py-2 text-right">Valor</th><th className="px-2 py-2 text-right">Ações</th></tr></thead><tbody>{displayedItems.map((item) => {const category = item.categoryId ? categoriesMap.get(item.categoryId) : null; const rowCategories = categories.filter((entry) => entry.direction === typeToDirection(item.type)); return <tr key={item.id} className="border-b border-gray-100"><td className="px-2 py-2">{editing?.id === item.id ? <input type="date" value={editing.date} onChange={(event) => setEditing({ ...editing, date: event.target.value })} className="rounded-md border border-gray-300 px-2 py-1 text-xs" /> : formatDate(item.occurredAt)}</td><td className="px-2 py-2">{item.type === "income" ? "Entrada" : "Saída"}</td><td className="px-2 py-2">{editing?.id === item.id ? <select value={editing.categoryId} onChange={(event) => setEditing({ ...editing, categoryId: event.target.value })} className="rounded-md border border-gray-300 px-2 py-1 text-xs"><option value="">Selecione</option>{rowCategories.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select> : category?.name ?? "—"}</td><td className="px-2 py-2">{editing?.id === item.id ? <input value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} className="rounded-md border border-gray-300 px-2 py-1 text-xs" /> : item.description ?? "—"}</td><td className="px-2 py-2 text-right">{editing?.id === item.id ? <input value={editing.amount} onChange={(event) => setEditing({ ...editing, amount: event.target.value })} className="w-24 rounded-md border border-gray-300 px-2 py-1 text-right text-xs" /> : formatBRL(item.amountCents)}</td><td className="px-2 py-2 text-right">{editing?.id === item.id ? <div className="flex justify-end gap-2"><button onClick={async () => {if (!editing.categoryId) return; setSavingEdit(true); const occurredAt = new Date(`${editing.date}T12:00:00`).toISOString(); const nextAmount = parseCurrencyToCents(editing.amount); const res = await fetch("/api/financial/transactions", {method: "PATCH", headers: {"Content-Type": "application/json"}, body: JSON.stringify({id: editing.id, categoryId: editing.categoryId, amountCents: nextAmount, occurredAt, description: editing.description || null, changeReason: "edicao manual via painel"})}); const json = (await res.json()) as ApiEnvelope<{id: string}>; setSavingEdit(false); if (!json.success) return setFeedback({type: "error", message: json.error ?? "Falha ao editar."}); setEditing(null); await loadTransactions();}} className="rounded-md bg-gray-900 px-2 py-1 text-xs text-white">{savingEdit ? "..." : "Salvar"}</button><button onClick={() => setEditing(null)} className="rounded-md border border-gray-300 px-2 py-1 text-xs">Cancelar</button></div> : <div className="flex justify-end gap-2"><button onClick={() => setEditing({id: item.id, date: item.occurredAt.slice(0, 10), categoryId: item.categoryId ?? "", amount: centsToInputValue(item.amountCents), description: item.description ?? ""})} className="rounded-md border border-gray-300 px-2 py-1 text-xs">Editar</button><button onClick={() => void handleDelete(item.id)} disabled={deletingId === item.id} className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700">{deletingId === item.id ? "..." : "Excluir"}</button></div>}</td></tr>;})}</tbody></table></div>}
      </section>
    </div>
  );
}
