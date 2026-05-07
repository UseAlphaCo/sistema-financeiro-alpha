import { z } from "zod";

export const categoryDirections = ["entrada", "saida"] as const;

const hexColorSchema = z.string().regex(/^#([0-9A-Fa-f]{6})$/, "Cor invalida. Use formato hexadecimal #RRGGBB.");

export const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(50),
  direction: z.enum(categoryDirections),
  color: hexColorSchema.optional(),
});

export const updateCategorySchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(2).max(50).optional(),
  direction: z.enum(categoryDirections).optional(),
  color: hexColorSchema.optional(),
});
