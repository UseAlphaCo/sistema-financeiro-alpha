export default function FinanceiroLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-gray-200 bg-white px-6 py-4">
        <nav className="flex items-center gap-6 text-sm font-medium text-gray-600">
          <span className="text-base font-semibold text-gray-900">
            Sistema Financeiro
          </span>
          <a href="/financeiro/integracoes" className="hover:text-gray-900">
            Integrações
          </a>
          <a href="/financeiro/fluxo-de-caixa" className="hover:text-gray-900">
            Fluxo de Caixa
          </a>
        </nav>
      </header>
      <main className="flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
