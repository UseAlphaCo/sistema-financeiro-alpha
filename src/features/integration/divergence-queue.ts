import { z } from "zod";

import { AppError } from "@/core/errors/app-error";

import { MAX_RETRY_ATTEMPTS } from "./shopify-reconciliation";
import {
  acceptDivergence,
  countDivergencesByStatus,
  ensureShopifyReconciliationTable,
  getDivergence,
  listOpenDivergences,
  requeueDivergence,
  STATUS_EM_ABERTO,
  type ReconciliationDivergenceRow,
  type ReconciliationStatus,
} from "./shopify-reconciliation-repository";

/**
 * Fila de tratamento de divergencia, do lado do operador.
 *
 * Ate aqui a lista por pedido so existia no CLI (`npm run reconcile:shopify --
 * --listar`). Este modulo e' o que a tela consome, e usa as MESMAS leituras do
 * CLI (`listOpenDivergences` e `countDivergencesByStatus`) para os dois nunca
 * contarem coisas diferentes.
 */

export type DivergenceQueue = {
  /** Abertas agora, maior dinheiro primeiro. */
  rows: ReconciliationDivergenceRow[];
  /** Contagem por status, a mesma do CLI. */
  counts: Record<ReconciliationStatus, number>;
  /** Teto de tentativas da rodada, para a tela dizer "esgotada". */
  maxAttempts: number;
};

export async function getDivergenceQueue(): Promise<DivergenceQueue> {
  await ensureShopifyReconciliationTable();
  const [rows, counts] = await Promise.all([listOpenDivergences(), countDivergencesByStatus()]);
  return { rows, counts, maxAttempts: MAX_RETRY_ATTEMPTS };
}

/** Id de pedido da Shopify: so digitos. Barra lixo antes de chegar ao SQL. */
const orderIdSchema = z.string().regex(/^\d{1,20}$/, "Id de pedido invalido.");

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reprocessar") }),
  z.object({
    action: z.literal("aceitar"),
    // Opcional, mas curto: e' o "por que" do aceite, para quem ler o historico.
    note: z.string().trim().max(500).optional(),
  }),
]);

export type DivergenceActionInput = z.infer<typeof actionSchema>;

/**
 * Aplica uma acao do operador sobre uma divergencia aberta.
 *
 * Devolve a linha como ficou. Os erros distinguem "nao existe" (404) de "ja
 * fechou" (409): na tela, o segundo quase sempre significa que a rodada ou
 * outra pessoa chegou antes, e a resposta certa e' recarregar, nao repetir.
 */
export async function applyDivergenceAction(
  rawOrderId: string,
  rawInput: unknown,
  actor: { email: string }
): Promise<ReconciliationDivergenceRow> {
  const orderId = orderIdSchema.safeParse(rawOrderId);
  if (!orderId.success) {
    throw new AppError("Id de pedido invalido.", 400, "VALIDATION_ERROR");
  }

  const input = actionSchema.safeParse(rawInput);
  if (!input.success) {
    throw new AppError("Acao invalida.", 400, "VALIDATION_ERROR", input.error.flatten());
  }

  await ensureShopifyReconciliationTable();

  const updated =
    input.data.action === "reprocessar"
      ? await requeueDivergence(orderId.data, MAX_RETRY_ATTEMPTS)
      : await acceptDivergence(orderId.data, {
          acceptedBy: actor.email,
          note: input.data.note ? input.data.note : null,
        });

  if (updated) return updated;

  const existente = await getDivergence(orderId.data);
  if (!existente) {
    throw new AppError("Divergencia nao encontrada.", 404, "NOT_FOUND");
  }
  if (!STATUS_EM_ABERTO.includes(existente.status)) {
    throw new AppError(
      `A divergencia ja esta fechada (${existente.status}). Recarregue a fila.`,
      409,
      "ALREADY_CLOSED"
    );
  }
  // Aberta e mesmo assim nao atualizou: so acontece sem banco configurado.
  throw new AppError("Nao foi possivel atualizar a divergencia.", 503, "UNAVAILABLE");
}
