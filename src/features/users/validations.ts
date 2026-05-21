import { z } from "zod";

import { MANAGED_USER_ROLES, USER_STATUSES } from "@/features/users/types";

export const createUserSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(MANAGED_USER_ROLES),
});

export const updateUserSchema = z.object({
  id: z.string().min(1),
  role: z.enum(MANAGED_USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});

export const deleteUserSchema = z.object({
  id: z.string().min(1),
});

export const resetUserPasswordSchema = z.discriminatedUnion("mode", [
  z.object({
    id: z.string().min(1),
    mode: z.literal("generated"),
  }),
  z.object({
    id: z.string().min(1),
    mode: z.literal("manual"),
    newPassword: z.string().min(6),
  }),
]);

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6),
});
