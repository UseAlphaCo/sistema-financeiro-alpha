import type { NextRequest } from "next/server";

import { auth } from "@/core/auth/auth";
import { assertAuthenticated, assertRole } from "@/core/auth/guards";
import { getSessionFromRequest } from "@/core/auth/session";
import { AppError } from "@/core/errors/app-error";
import { logError, logInfo } from "@/core/observability/logger";
import { trackEndpointCall } from "@/core/observability/telemetry";
import { createApiError } from "@/shared/api/envelope";
import type { UserRole, UserSession } from "@/types/api";

type SecurityOptions = {
  requireAuth?: boolean;
  allowedRoles?: UserRole[];
  rateLimit?: number;
  sensitive?: boolean;
};

type SecurityContext = {
  requestId: string;
  session: UserSession | null;
};

type RateEntry = {
  count: number;
  windowStartMs: number;
};

const ONE_MINUTE_MS = 60_000;
const rateBucket = new Map<string, RateEntry>();

function normalizeRole(value: string | null | undefined): UserRole | null {
  if (!value) return null;

  const lowered = value.toLowerCase();
  switch (lowered) {
    case "admin":
      return "admin";
    case "financeiro":
      return "financeiro";
    case "operador":
      return "operador";
    case "parceiro":
      return "parceiro";
    case "influenciador":
      return "influenciador";
    default:
      return null;
  }
}

async function resolveSession(request: NextRequest): Promise<UserSession | null> {
  const sessionFromHeaders = getSessionFromRequest(request);
  if (sessionFromHeaders) {
    return sessionFromHeaders;
  }

  try {
    const nextAuthSession = await auth();
    const user = nextAuthSession?.user;
    const role = normalizeRole(user?.role);

    if (!user?.id || !user?.email || !role) {
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      role,
    };
  } catch {
    return null;
  }
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

function checkRateLimit(request: NextRequest, limit: number): boolean {
  const ip = getClientIp(request);
  const key = `${ip}:${request.nextUrl.pathname}`;
  const now = Date.now();

  const current = rateBucket.get(key);
  if (!current || now - current.windowStartMs >= ONE_MINUTE_MS) {
    rateBucket.set(key, { count: 1, windowStartMs: now });
    return true;
  }

  if (current.count >= limit) {
    return false;
  }

  current.count += 1;
  rateBucket.set(key, current);
  return true;
}

export async function withApiSecurity(
  request: NextRequest,
  options: SecurityOptions,
  handler: (ctx: SecurityContext) => Promise<Response>
) {
  const startedAt = Date.now();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  try {
    const session = await resolveSession(request);

    if (options.requireAuth) {
      assertAuthenticated(session);
    }

    if (options.allowedRoles && options.allowedRoles.length > 0) {
      assertRole(session, options.allowedRoles);
    }

    if (options.rateLimit && options.rateLimit > 0) {
      const allowed = checkRateLimit(request, options.rateLimit);
      if (!allowed) {
        throw new AppError("Rate limit excedido.", 429, "RATE_LIMIT");
      }
    }

    const response = await handler({ requestId, session });
    trackEndpointCall(request.nextUrl.pathname, Date.now() - startedAt, false);

    if (options.sensitive) {
      const logPayload = {
        requestId,
        endpoint: request.nextUrl.pathname,
        role: session?.role ?? null,
        status: response.status,
      };
      if (response.status >= 400) {
        logError("api_request_failed", logPayload);
      } else {
        logInfo("api_request_success", logPayload);
      }
    }

    return response;
  } catch (error) {
    trackEndpointCall(request.nextUrl.pathname, Date.now() - startedAt, true);

    if (error instanceof AppError) {
      logError("api_request_error", {
        requestId,
        endpoint: request.nextUrl.pathname,
        code: error.code,
        status: error.status,
      });
      return createApiError(requestId, error.message, error.status, { code: error.code });
    }

    logError("api_request_unhandled_error", {
      requestId,
      endpoint: request.nextUrl.pathname,
      error: error instanceof Error ? error.message : "erro desconhecido",
    });
    return createApiError(requestId, "Erro interno do servidor.", 500);
  }
}

export type { SecurityContext, SecurityOptions };
