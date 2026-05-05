import { createServerClient } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";

import type { UserRole } from "@/types/api";

const PROTECTED_PAGE_PREFIXES = ["/financeiro"];
const PROTECTED_API_PREFIX = "/api/financial";

function normalizeRole(value: unknown): UserRole | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  const allowed: UserRole[] = ["admin", "financeiro", "operador", "parceiro", "influenciador"];
  return allowed.includes(lowered as UserRole) ? (lowered as UserRole) : null;
}

function isAllowedRole(role: UserRole | null): boolean {
  return role === "admin" || role === "financeiro";
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((p) => pathname.startsWith(p));
  const isProtectedApi = pathname.startsWith(PROTECTED_API_PREFIX);

  if (!isProtectedPage && !isProtectedApi) {
    return NextResponse.next();
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  // Env vars ausentes — fail seguro em vez de crash (MIDDLEWARE_INVOCATION_FAILED)
  if (!supabaseUrl || !supabaseKey) {
    if (isProtectedApi) {
      return NextResponse.json(
        { success: false, data: null, error: "Servico de autenticacao nao configurado.", requestId: crypto.randomUUID(), meta: { timestamp: new Date().toISOString() } },
        { status: 503 }
      );
    }
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "misconfigured");
    return NextResponse.redirect(url);
  }

  // Renovação de sessão Supabase via SSR
  const response = NextResponse.next({
    request: { headers: new Headers(request.headers) },
  });

  let user: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null = null;

  try {
    const supabase = createServerClient(supabaseUrl, supabaseKey, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options);
          });
        },
      },
    });
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    if (isProtectedApi) {
      return NextResponse.json(
        { success: false, data: null, error: "Erro ao verificar autenticacao.", requestId: crypto.randomUUID(), meta: { timestamp: new Date().toISOString() } },
        { status: 503 }
      );
    }
    const url = new URL("/login", request.url);
    url.searchParams.set("error", "auth_error");
    return NextResponse.redirect(url);
  }

  if (!user) {
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

  const role = normalizeRole(user.user_metadata?.role);

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

  // Injeta headers para withApiSecurity e getSessionFromRequest
  response.headers.set("x-user-id", user.id);
  response.headers.set("x-user-email", user.email ?? "");
  response.headers.set("x-user-role", role!);

  return response;
}

export const config = {
  matcher: ["/financeiro/:path*", "/api/financial/:path*"],
};

