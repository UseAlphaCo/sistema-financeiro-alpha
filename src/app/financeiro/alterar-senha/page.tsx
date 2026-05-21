"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AlterarSenhaPage() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (newPassword !== confirmPassword) {
      setError("A confirmacao de senha nao confere.");
      return;
    }

    setLoading(true);

    const response = await fetch("/api/financial/users/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    const body = (await response.json()) as { success: boolean; error: string | null };

    setLoading(false);

    if (!response.ok || !body.success) {
      setError(body.error ?? "Falha ao alterar senha.");
      return;
    }

    setSuccess("Senha atualizada com sucesso.");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");

    router.push("/financeiro/fluxo-de-caixa");
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-md rounded-lg border border-gray-200 bg-white p-6">
      <h1 className="text-lg font-semibold text-gray-900">Alterar senha</h1>
      <p className="mt-1 text-sm text-gray-500">Atualize sua senha para continuar usando o sistema.</p>

      <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
        <div>
          <label className="block text-sm font-medium text-gray-700" htmlFor="currentPassword">
            Senha atual
          </label>
          <input
            id="currentPassword"
            type="password"
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700" htmlFor="newPassword">
            Nova senha
          </label>
          <input
            id="newPassword"
            type="password"
            minLength={6}
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700" htmlFor="confirmPassword">
            Confirmar nova senha
          </label>
          <input
            id="confirmPassword"
            type="password"
            minLength={6}
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
        {success && <p className="text-sm text-emerald-600">{success}</p>}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {loading ? "Salvando..." : "Atualizar senha"}
        </button>
      </form>
    </div>
  );
}
