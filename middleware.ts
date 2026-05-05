import { NextRequest, NextResponse } from "next/server";

import { ROLES, type UserRole } from "@/types/api";

const PROTECTED_PAGE_PREFIXES = ["/dashboard", "/financeiro"];
const PROTECTED_API_PREFIX = "/api/financial";

function normalizeRole(value: string | null): UserRole | null {
  if (!value) return null;
  const lowered = value.toLowerCase();
  return ROLES.includes(lowered as UserRole) ? (lowered as UserRole) : null;
}

function getRoleFromRequest(request: NextRequest): UserRole | null {
  const headerRole = normalizeRole(request.headers.get("x-user-role"));
  if (headerRole) return headerRole;

  const cookieRole = normalizeRole(request.cookies.get("sf_role")?.value ?? null);
  if (cookieRole) return cookieRole;

  const bypass = process.env.AUTH_BYPASS_IN_DEV === "true";
  if (bypass && process.env.NODE_ENV !== "production") {
    return "admin";
  }

  return null;
}

function isAllowedRole(role: UserRole | null): boolean {
  if (!role) return false;
  return role === "admin" || role === "financeiro";
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const role = getRoleFromRequest(request);

  const isProtectedPage = PROTECTED_PAGE_PREFIXES.some((prefix) =>
    pathname.startsWith(prefix)
  );
  const isProtectedApi = pathname.startsWith(PROTECTED_API_PREFIX);

  if (!isProtectedPage && !isProtectedApi) {
    return NextResponse.next();
  }

  if (isAllowedRole(role)) {
    return NextResponse.next();
  }

  if (isProtectedApi) {
    return NextResponse.json(
      {
        success: false,
        data: null,
        error: "Nao autenticado para acessar este recurso.",
        requestId: crypto.randomUUID(),
        meta: { timestamp: new Date().toISOString() },
      },
      { status: 401 }
    );
  }

  const redirectUrl = new URL("/", request.url);
  redirectUrl.searchParams.set("auth", "required");
  return NextResponse.redirect(redirectUrl);
}

export const config = {
  matcher: ["/dashboard/:path*", "/financeiro/:path*", "/api/financial/:path*"],
};
