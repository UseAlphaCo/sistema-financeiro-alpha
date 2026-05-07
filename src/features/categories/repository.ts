import { getPrismaClient } from "@/core/db/prisma-client";

import type { CreateCategoryInput, UpdateCategoryInput } from "@/features/categories/types";

export async function listCategories() {
  const prisma = getPrismaClient();
  return prisma.transactionCategory.findMany({ orderBy: [{ direction: "asc" }, { name: "asc" }] });
}

export async function getCategoryById(id: string) {
  const prisma = getPrismaClient();
  return prisma.transactionCategory.findUnique({ where: { id } });
}

export async function createCategory(input: CreateCategoryInput) {
  const prisma = getPrismaClient();
  return prisma.transactionCategory.create({
    data: {
      name: input.name.trim(),
      direction: input.direction,
      color: input.color ?? null,
    },
  });
}

export async function updateCategory(input: UpdateCategoryInput) {
  const prisma = getPrismaClient();
  const { id, ...data } = input;

  return prisma.transactionCategory.update({
    where: { id },
    data: {
      name: data.name?.trim(),
      direction: data.direction,
      color: data.color,
    },
  });
}

export async function countTransactionsByCategoryId(id: string): Promise<number> {
  const prisma = getPrismaClient();
  return prisma.financialTransaction.count({ where: { categoryId: id, deletedAt: null } });
}

export async function deleteCategory(id: string) {
  const prisma = getPrismaClient();
  return prisma.transactionCategory.delete({ where: { id } });
}
