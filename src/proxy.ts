import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/core/auth/auth";
import type { UserRole } from "@/types/api";

const PROTECTED_PAGE_PREFIXES = [
  "/dashboard",
  "/fluxo-de-caixa",
  "/lancamentos",
  "/importacoes",
  "/integracoes",
  "/usuarios",
  "/alterar-senha",
  "/reconciliacao",
];
const PROTECTED_API_PREFIX = "/api/financial";

/**
 * FREEZE TEMPORARIO CORE FIN -- interruptor, agora DESLIGADO por padrao.
 *
 * Derruba as paginas do app com 503, mantendo as APIs (/api/financial,
 * /api/internal, /api/webhooks, /api/health) respondendo normalmente.
 *
 * Ficou ligado por padrao de 22/08 a 25/08/2026, enquanto o consumo do OMS era
 * investigado. O motivo acabou: a varredura por ctid substituiu a consulta sem
 * indice que derrubava o ciclo, e a materializacao passou a ter cron proprio.
 *
 * O default inverteu porque "ligado por padrao" tornava o descongelamento
 * dependente de uma variavel de ambiente na Vercel -- deployar o codigo certo
 * nao bastava. Agora o deploy reabre, e o freeze continua a um
 * MAINTENANCE_MODE="true" de distancia se precisar voltar.
 */
const MAINTENANCE_MODE = process.env.MAINTENANCE_MODE === "true";

/**
 * Rotas de API congeladas junto com as paginas.
 *
 * /api/internal/* concentra as rotas de cron, que abrem pools pg contra o OMS
 * e o CORE. O 503 e devolvido aqui, antes do handler, entao a requisicao nao
 * chega a abrir conexao no Postgres nem a segurar duracao de function.
 *
 * /api/health fica de fora de proposito, para continuar observando o banco
 * durante o freeze.
 */
const FROZEN_API_PREFIXES = ["/api/internal"];

const MAINTENANCE_PAGE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sistema Financeiro - em manutencao</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background:#0b0b0f; color:#e8e8ed; }
  main { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .75rem; font-weight:600; }
  p { margin:0; color:#a1a1aa; line-height:1.6; font-size:.95rem; }
</style>
</head>
<body>
<main>
  <h1>Sistema em manutencao</h1>
  <p>O Sistema Financeiro esta temporariamente indisponivel para manutencao programada. Tente novamente mais tarde.</p>
</main>
</body>
</html>`;

function normalizeRole(value: unknown): UserRole | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  const allowed: UserRole[] = ["admin", "financeiro", "operador", "parceiro", "influenciador"];
  return allowed.includes(lowered as UserRole) ? (lowered as UserRole) : null;
}

function isAllowedRole(role: UserRole | null): boolean {
  return role === "admin" || role === "financeiro";
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isRootPath = pathname === "/";
  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((p) => pathname.startsWith(p));
  const isProtectedApi = pathname.startsWith(PROTECTED_API_PREFIX);
  const isFrozenApi = FROZEN_API_PREFIXES.some((p) => pathname.startsWith(p));

  // Gate de manutencao das APIs congeladas: precisa vir antes do early return
  // abaixo, senao /api/internal/* passaria direto para o handler.
  if (MAINTENANCE_MODE && isFrozenApi) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: "Servico temporariamente congelado para manutencao.",
        requestId: crypto.randomUUID(),
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "3600" } }
    );
  }

  if (!isRootPath && !isProtectedPage && !isProtectedApi) {
    return NextResponse.next();
  }

  // Gate de manutencao: vem antes de auth() de proposito, para que nenhuma
  // pagina bloqueada chegue a consultar a sessao no banco.
  if (MAINTENANCE_MODE && (isRootPath || isProtectedPage)) {
    return new NextResponse(MAINTENANCE_PAGE, {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "3600",
      },
    });
  }

  const session = await auth();
  const user = session?.user;

  if (!user?.id || !user.email) {
    if (isProtectedApi) {
      return NextResponse.json(
        { success: false, data: null, error: "Nao autenticado para acessar este recurso.", requestId: crypto.randomUUID(), meta: { timestamp: new Date().toISOString() } },
        { status: 401 }
      );
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  const role = normalizeRole(user.role);

  if (!isAllowedRole(role)) {
    if (isProtectedApi) {
      return NextResponse.json(
        { success: false, data: null, error: "Sem permissao para acessar este recurso.", requestId: crypto.randomUUID(), meta: { timestamp: new Date().toISOString() } },
        { status: 403 }
      );
    }

    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "forbidden");
    return NextResponse.redirect(loginUrl);
  }

  const roleValue = role as UserRole;

  if (pathname.startsWith("/usuarios") && role !== "admin") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "forbidden");
    return NextResponse.redirect(loginUrl);
  }

  if (pathname.startsWith("/reconciliacao") && role !== "admin") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "forbidden");
    return NextResponse.redirect(loginUrl);
  }

  const isPasswordPage = pathname.startsWith("/alterar-senha");
  if (user.forcePasswordChange && !isPasswordPage && !isProtectedApi) {
    return NextResponse.redirect(new URL("/alterar-senha", request.url));
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-id", user.id);
  requestHeaders.set("x-user-email", user.email);
  requestHeaders.set("x-user-role", roleValue);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  return response;
}

export const config = {
  matcher: [
    "/",
    "/dashboard/:path*",
    "/fluxo-de-caixa/:path*",
    "/lancamentos/:path*",
    "/importacoes/:path*",
    "/integracoes/:path*",
    "/usuarios/:path*",
    "/alterar-senha/:path*",
    "/reconciliacao/:path*",
    "/api/financial/:path*",
    // Incluida para o freeze: fora dele o middleware apenas deixa passar.
    "/api/internal/:path*",
  ],
};

