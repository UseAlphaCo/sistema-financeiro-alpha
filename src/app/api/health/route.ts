import { createApiSuccess } from "@/shared/api/envelope";

export async function GET() {
  const requestId = crypto.randomUUID();
  return createApiSuccess(requestId, {
    status: "ok",
    service: "sistema-financeiro",
    version: "0.1.0",
  });
}
