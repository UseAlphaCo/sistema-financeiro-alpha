import { createSupabaseServerClient } from "@/core/auth/supabase-server";

export default async function FinanceiroPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const role = (user?.user_metadata?.role as string) ?? "—";

  const links = [
    { href: "/financeiro/fluxo-de-caixa", label: "Fluxo de Caixa", description: "Entradas, saídas e saldo líquido por período" },
    { href: "/financeiro/integracoes", label: "Integrações", description: "Eventos recebidos via webhook Shopify" },
  ];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-semibold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Bem-vindo, <span className="font-medium">{user?.email}</span>{" "}
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500">
            {role}
          </span>
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="rounded-lg border border-gray-200 bg-white p-5 hover:border-gray-300 hover:shadow-sm"
          >
            <p className="font-medium text-gray-900">{link.label}</p>
            <p className="mt-1 text-sm text-gray-500">{link.description}</p>
          </a>
        ))}
      </div>
    </div>
  );
}
