import { AppError } from "@/core/errors/app-error";
import { getTransactionsRepository } from "@/features/transactions/repository";
import {
  createTransactionSchema,
  deleteTransactionSchema,
  listTransactionsFiltersSchema,
  updateTransactionSchema,
} from "@/features/transactions/validations";
import type { ActionResult } from "@/types/api";

export async function listTransactionsAction(input: unknown) {
  const parsed = listTransactionsFiltersSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Filtros invalidos para listagem.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  const repository = getTransactionsRepository();
  return repository.list(parsed.data);
}

export async function createTransactionAction(
  input: unknown,
  actorId: string
): Promise<ActionResult<{ id: string }>> {
  const parsed = createTransactionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: "Payload invalido para criacao de transacao.",
    };
  }

  const repository = getTransactionsRepository();
  const created = await repository.create(parsed.data, actorId);

  return {
    success: true,
    data: { id: created.id },
  };
}

export async function updateTransactionAction(
  input: unknown,
  actorId: string
): Promise<ActionResult<{ id: string }>> {
  const parsed = updateTransactionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: "Payload invalido para atualizacao de transacao.",
    };
  }

  const repository = getTransactionsRepository();
  const updated = await repository.update(parsed.data, actorId);
  if (!updated) {
    return {
      success: false,
      error: "Transacao nao encontrada.",
    };
  }

  return {
    success: true,
    data: { id: updated.id },
  };
}

export async function deleteTransactionAction(
  input: unknown,
  actorId: string
): Promise<ActionResult<{ id: string }>> {
  const parsed = deleteTransactionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: "Payload invalido para exclusao de transacao.",
    };
  }

  const repository = getTransactionsRepository();
  const removed = await repository.remove(parsed.data, actorId);
  if (!removed) {
    return {
      success: false,
      error: "Transacao nao encontrada.",
    };
  }

  return {
    success: true,
    data: { id: parsed.data.id },
  };
}
