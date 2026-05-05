import type { NextRequest } from "next/server";

import { ROLES, type UserRole, type UserSession } from "@/types/api";

function normalizeRole(value: string | null): UserRole | null {
  if (!value) return null;
  const lowered = value.toLowerCase();
  return ROLES.includes(lowered as UserRole) ? (lowered as UserRole) : null;
}

export function getSessionFromHeaders(headers: Headers): UserSession | null {
  const role = normalizeRole(headers.get("x-user-role"));
  const id = headers.get("x-user-id");
  const email = headers.get("x-user-email");

  if (role && id && email) {
    return { id, email, role };
  }

  const bypass = process.env.AUTH_BYPASS_IN_DEV === "true";
  if (bypass && process.env.NODE_ENV !== "production") {
    return {
      id: "dev-admin",
      email: "dev-admin@sistema-financeiro.local",
      role: "admin",
    };
  }

  return null;
}

export function getSessionFromRequest(request: Request | NextRequest): UserSession | null {
  return getSessionFromHeaders(request.headers);
}
