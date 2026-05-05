import { AppError } from "@/core/errors/app-error";
import type { UserRole, UserSession } from "@/types/api";

export function assertAuthenticated(session: UserSession | null): asserts session is UserSession {
  if (!session) {
    throw new AppError("Nao autenticado.", 401, "UNAUTHORIZED");
  }
}

export function assertRole(session: UserSession | null, allowedRoles: UserRole[]) {
  assertAuthenticated(session);
  if (!allowedRoles.includes(session.role)) {
    throw new AppError("Sem permissao para acessar este recurso.", 403, "FORBIDDEN");
  }
}
