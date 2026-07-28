"use client";
import { useEffect, useState, FormEvent } from "react";

type Category = {
  id: string;
  name: string;
  direction: string;
  color: string | null;
};

type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
  requestId: string;
  meta: Record<string, unknown>;
};

export function CategoriaContent() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [direction, setDirection] = useState("entrada");
  const [color, setColor] = useState("#0f766e");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  async function loadCategories() {
    const res = await fetch("/api/financial/categories", { cache: "no-store" });
    const json = (await res.json()) as ApiEnvelope<Category[]>;
    if (json.success && json.data) setCategories(json.data);
  }

  useEffect(() => {
    // Evita chamada direta de setState dentro do corpo do effect
    (async () => { await loadCategories(); })();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const method = editingId ? "PUT" : "POST";
    const url = editingId ? `/api/financial/categories/${editingId}` : "/api/financial/categories";
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, direction, color }),
    });
    const json = (await res.json()) as ApiEnvelope<Category>;
    if (json.success) {
      setFeedback(editingId ? "Categoria atualizada!" : "Categoria criada!");
      setName("");
      setDirection("entrada");
      setColor("#0f766e");
      setEditingId(null);
      loadCategories();
    } else {
      setFeedback(json.error ?? "Erro ao salvar categoria.");
    }
  }

  async function handleEdit(cat: Category) {
    setEditingId(cat.id);
    setName(cat.name);
    setDirection(cat.direction);
    setColor(cat.color ?? "#0f766e");
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Deseja remover esta categoria?")) return;
    const res = await fetch(`/api/financial/categories/${id}`, { method: "DELETE" });
    const json = (await res.json()) as ApiEnvelope<{ id: string }>;
    if (json.success) {
      setFeedback("Categoria removida!");
      loadCategories();
    } else {
      setFeedback(json.error ?? "Erro ao remover categoria.");
    }
  }

  return (
    <div className="space-y-8">
      {feedback && (
        <div className="rounded-md px-4 py-3 text-sm bg-green-50 text-green-700">{feedback}</div>
      )}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Coluna 1: Formulário */}
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium text-gray-700">
            {editingId ? "Editar categoria" : "Nova categoria"}
          </h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-3">
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Nome"
              required
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            />
            <select
              value={direction}
              onChange={e => setDirection(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="entrada">Entrada</option>
              <option value="saida">Saída</option>
            </select>
            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-500">Cor</label>
              <input
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
                className="h-9 w-14 rounded-md border border-gray-300 cursor-pointer"
              />
            </div>
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white hover:bg-gray-700"
            >
              {editingId ? "Salvar alterações" : "Adicionar categoria"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => { setEditingId(null); setName(""); setDirection("entrada"); setColor("#0f766e"); }}
                className="rounded-md border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancelar
              </button>
            )}
          </form>
        </div>

        {/* Coluna 2: Listagem */}
        <div className="rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium text-gray-700">Categorias cadastradas</h2>
          {categories.length === 0 ? (
            <p className="text-sm text-gray-500">Nenhuma categoria cadastrada.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500">
                    <th className="px-2 py-2">Nome</th>
                    <th className="px-2 py-2">Tipo</th>
                    <th className="px-2 py-2">Cor</th>
                    <th className="px-2 py-2 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {categories.map(cat => (
                    <tr key={cat.id} className="border-b border-gray-100">
                      <td className="px-2 py-2">{cat.name}</td>
                      <td className="px-2 py-2">{cat.direction === "entrada" ? "Entrada" : "Saída"}</td>
                      <td className="px-2 py-2">
                        <span
                          className="inline-block h-4 w-4 rounded-full border border-gray-200"
                          style={{ backgroundColor: cat.color ?? "#e5e7eb" }}
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => handleEdit(cat)}
                            className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => handleDelete(cat.id)}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                          >
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
