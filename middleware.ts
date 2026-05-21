import { NextRequest, NextResponse } from "next/server";

import { auth } from "@/core/auth/auth";
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

  if (pathname.startsWith("/financeiro/usuarios") && role !== "admin") {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "forbidden");
    return NextResponse.redirect(loginUrl);
  }

  const isPasswordPage = pathname.startsWith("/financeiro/alterar-senha");
  if (user.forcePasswordChange && !isPasswordPage && !isProtectedApi) {
    return NextResponse.redirect(new URL("/financeiro/alterar-senha", request.url));
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
  matcher: ["/financeiro/:path*", "/api/financial/:path*"],
};

