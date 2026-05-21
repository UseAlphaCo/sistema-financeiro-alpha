"use client";

import { useMemo, useState } from "react";

import type { ManagedUserRole, UserRecord, UserStatus } from "@/features/users/types";

type CreateUserResponse = {
  success: boolean;
  data: {
    user: UserRecord;
    tempPassword: string;
  } | null;
  error: string | null;
};

const AVAILABLE_ROLES: ManagedUserRole[] = ["admin", "financeiro"];

type Props = {
  initialUsers: UserRecord[];
};

export default function UsuariosClient({ initialUsers }: Props) {
  const [items, setItems] = useState<UserRecord[]>(initialUsers);
  const [error, setError] = useState<string | null>(null);

  const [createEmail, setCreateEmail] = useState("");
  const [createRole, setCreateRole] = useState<ManagedUserRole>("financeiro");
  const [createLoading, setCreateLoading] = useState(false);
  const [lastTempPassword, setLastTempPassword] = useState<string | null>(null);

  const [savingId, setSavingId] = useState<string | null>(null);

  const usersSorted = useMemo(() => items, [items]);

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateLoading(true);
    setError(null);
    setLastTempPassword(null);

    const response = await fetch("/api/financial/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: createEmail,
        role: createRole,
      }),
    });

    const body = (await response.json()) as CreateUserResponse;

    if (!response.ok || !body.success || !body.data) {
      setError(body.error ?? "Falha ao criar usuario.");
      setCreateLoading(false);
      return;
    }

    setItems((prev) => [body.data!.user, ...prev]);
    setLastTempPassword(body.data.tempPassword);
    setCreateEmail("");
    setCreateRole("financeiro");
    setCreateLoading(false);
  }

  async function updateUser(userId: string, payload: { role?: ManagedUserRole; status?: UserStatus }) {
    setSavingId(userId);
    setError(null);

    const response = await fetch(`/api/financial/users/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const body = (await response.json()) as {
      success: boolean;
      data: UserRecord | null;
      error: string | null;
    };

    if (!response.ok || !body.success || !body.data) {
      setError(body.error ?? "Falha ao atualizar usuario.");
      setSavingId(null);
      return;
    }

    setItems((prev) => prev.map((item) => (item.id === userId ? body.data! : item)));
    setSavingId(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">Gerenciamento de usuarios</h1>
        <p className="mt-1 text-sm text-gray-500">Somente administradores podem criar, editar role e desativar acesso.</p>
      </div>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Convidar usuario</h2>
        <form className="mt-3 grid gap-3 sm:grid-cols-3" onSubmit={handleCreateUser}>
          <input
            required
            type="email"
            value={createEmail}
            onChange={(e) => setCreateEmail(e.target.value)}
            placeholder="email@empresa.com"
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          />
          <select
            value={createRole}
            onChange={(e) => setCreateRole(e.target.value as ManagedUserRole)}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm"
          >
            {AVAILABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={createLoading}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          >
            {createLoading ? "Criando..." : "Criar usuario"}
          </button>
        </form>

        {lastTempPassword && (
          <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Senha temporaria (mostrada uma unica vez): <strong>{lastTempPassword}</strong>
          </p>
        )}
      </section>

      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Usuarios</h2>

        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-2 pr-4">E-mail</th>
                <th className="py-2 pr-4">Role</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Criado em</th>
                <th className="py-2">Acoes</th>
              </tr>
            </thead>
            <tbody>
              {usersSorted.map((user) => (
                <tr key={user.id} className="border-b border-gray-100 align-top">
                  <td className="py-2 pr-4 text-gray-900">{user.email}</td>
                  <td className="py-2 pr-4">
                    <select
                      value={user.role}
                      disabled={savingId === user.id}
                      onChange={(e) => void updateUser(user.id, { role: e.target.value as ManagedUserRole })}
                      className="rounded-md border border-gray-300 px-2 py-1"
                    >
                      {AVAILABLE_ROLES.map((role) => (
                        <option key={role} value={role}>
                          {role}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        user.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      }`}
                    >
                      {user.status}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-600">
                    {new Date(user.createdAt).toLocaleDateString("pt-BR")}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      disabled={savingId === user.id}
                      onClick={() =>
                        void updateUser(user.id, {
                          status: user.status === "active" ? "disabled" : "active",
                        })
                      }
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                    >
                      {user.status === "active" ? "Desativar" : "Reativar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </section>
    </div>
  );
}
