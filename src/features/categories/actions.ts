import { AppError } from "@/core/errors/app-error";
import * as repo from "@/features/categories/repository";
import type { CreateCategoryInput, UpdateCategoryInput } from "@/features/categories/types";
import { createCategorySchema, updateCategorySchema } from "@/features/categories/validations";

export async function listCategories() {
  return repo.listCategories();
}

export async function getCategoryById(id: string) {
  return repo.getCategoryById(id);
}

export async function createCategory(input: CreateCategoryInput) {
  const parsed = createCategorySchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Payload invalido para criacao de categoria.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  return repo.createCategory(parsed.data);
}

export async function updateCategory(input: UpdateCategoryInput) {
  const parsed = updateCategorySchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Payload invalido para atualizacao de categoria.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  const existing = await repo.getCategoryById(parsed.data.id);
  if (!existing) {
    throw new AppError("Categoria nao encontrada.", 404, "NOT_FOUND");
  }

  return repo.updateCategory(parsed.data);
}

export async function deleteCategory(id: string) {
  const existing = await repo.getCategoryById(id);
  if (!existing) {
    throw new AppError("Categoria nao encontrada.", 404, "NOT_FOUND");
  }

  const usageCount = await repo.countTransactionsByCategoryId(id);
  if (usageCount > 0) {
    throw new AppError("Categoria em uso por lancamentos e nao pode ser removida.", 409, "CATEGORY_IN_USE", {
      usageCount,
    });
  }

  await repo.deleteCategory(id);
  return { id };
}
