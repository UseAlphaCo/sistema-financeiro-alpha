import { AppError } from "@/core/errors/app-error";
import * as categoriesRepository from "@/features/categories/repository";
import { getTransactionsRepository } from "@/features/transactions/repository";
import {
  createTransactionSchema,
  deleteTransactionSchema,
  listTransactionsFiltersSchema,
  updateTransactionSchema,
} from "@/features/transactions/validations";
import type { ActionResult } from "@/types/api";

function requiredDirectionByType(type: "income" | "expense" | "transfer") {
  if (type === "income") return "entrada" as const;
  if (type === "expense") return "saida" as const;
  return null;
}

async function ensureCategoryMatchesType(params: { categoryId: string; type: "income" | "expense" }) {
  const category = await categoriesRepository.getCategoryById(params.categoryId);

  if (!category) {
    return {
      success: false as const,
      error: "Categoria informada nao existe.",
    };
  }

  const expectedDirection = requiredDirectionByType(params.type);
  if (expectedDirection && category.direction !== expectedDirection) {
    return {
      success: false as const,
      error: "Categoria incompatível com o tipo do lancamento.",
    };
  }

  return { success: true as const };
}

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

  if (parsed.data.type === "transfer" && parsed.data.categoryId) {
    return {
      success: false,
      error: "Lancamentos do tipo transferencia nao aceitam categoria.",
    };
  }

  if (parsed.data.type !== "transfer") {
    if (!parsed.data.categoryId) {
      return {
        success: false,
        error: "Categoria e obrigatoria para entradas e saidas.",
      };
    }

    const categoryValidation = await ensureCategoryMatchesType({
      categoryId: parsed.data.categoryId,
      type: parsed.data.type,
    });

    if (!categoryValidation.success) {
      return categoryValidation;
    }
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
  const existing = await repository.findById(parsed.data.id);

  if (!existing) {
    return {
      success: false,
      error: "Transacao nao encontrada.",
    };
  }

  if (existing.type === "transfer" && parsed.data.categoryId) {
    return {
      success: false,
      error: "Lancamentos do tipo transferencia nao aceitam categoria.",
    };
  }

  if (existing.type !== "transfer") {
    if (parsed.data.categoryId === null) {
      return {
        success: false,
        error: "Categoria e obrigatoria para entradas e saidas.",
      };
    }

    if (parsed.data.categoryId) {
      const categoryValidation = await ensureCategoryMatchesType({
        categoryId: parsed.data.categoryId,
        type: existing.type,
      });

      if (!categoryValidation.success) {
        return categoryValidation;
      }
    }
  }

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
