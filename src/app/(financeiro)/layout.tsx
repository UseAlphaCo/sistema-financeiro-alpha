import { createSupabaseServerClient } from "@/core/auth/supabase-server";

export default async function FinanceiroLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <nav className="flex items-center gap-6 text-sm font-medium text-gray-600">
          <span className="text-base font-semibold text-gray-900">
            Sistema Financeiro
          </span>
          <a href="/financeiro" className="hover:text-gray-900">
            Dashboard
          </a>
          <a href="/financeiro/fluxo-de-caixa" className="hover:text-gray-900">
            Fluxo de Caixa
          </a>
          <a href="/financeiro/importacoes" className="hover:text-gray-900">
            Importações
          </a>
          <a href="/financeiro/integracoes" className="hover:text-gray-900">
            Integrações
          </a>

          <div className="ml-auto flex items-center gap-4">
            {user && (
              <span className="text-xs text-gray-400">{user.email}</span>
            )}
            <form action="/api/auth/logout" method="POST">
              <button
                type="submit"
                className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              >
                Sair
              </button>
            </form>
          </div>
        </nav>
      </header>
      <main className="flex-1 px-6 py-8">{children}</main>
    </div>
  );
}

