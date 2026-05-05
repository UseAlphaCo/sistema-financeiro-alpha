export const ROLES = [
  "admin",
  "financeiro",
  "operador",
  "parceiro",
  "influenciador",
] as const;

export type UserRole = (typeof ROLES)[number];

export type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
  requestId: string;
  meta: {
    timestamp: string;
    [key: string]: unknown;
  };
};

export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: string };

export type UserSession = {
  id: string;
  email: string;
  role: UserRole;
};
