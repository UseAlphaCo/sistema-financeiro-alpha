export default function Home() {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-zinc-100 px-6 py-16">
      <main className="w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white p-10 shadow-sm">
        <h1 className="text-3xl font-bold tracking-tight text-zinc-900">
          Sistema Financeiro
        </h1>
        <p className="mt-3 text-zinc-600">
          Base inicial criada com estrutura modular, middleware de seguranca e
          rotas financeiras protegidas.
        </p>

        <div className="mt-8 grid gap-3 text-sm">
          <a className="rounded-lg border border-zinc-200 px-4 py-3 hover:bg-zinc-50" href="/api/health">
            GET /api/health
          </a>
          <a className="rounded-lg border border-zinc-200 px-4 py-3 hover:bg-zinc-50" href="/api/financial/dashboard">
            GET /api/financial/dashboard
          </a>
          <a className="rounded-lg border border-zinc-200 px-4 py-3 hover:bg-zinc-50" href="/api/financial/transactions">
            GET /api/financial/transactions
          </a>
        </div>
      </main>
    </div>
  );
}
