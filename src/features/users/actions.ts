import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";

import { assertRole } from "@/core/auth/guards";
import { AppError } from "@/core/errors/app-error";
import * as usersRepository from "@/features/users/repository";
import { createUserSchema, updateUserSchema } from "@/features/users/validations";
import type { UserSession } from "@/types/api";

function generateTempPassword() {
  return randomBytes(6).toString("base64url");
}

export async function listUsersAction(session: UserSession | null) {
  assertRole(session, ["admin"]);
  return usersRepository.listUsers();
}

export async function createUserAction(input: unknown, session: UserSession | null) {
  assertRole(session, ["admin"]);

  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Payload invalido para criacao de usuario.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  const tempPassword = generateTempPassword();

  let user;
  try {
    user = await usersRepository.createUser(parsed.data, tempPassword);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError("Ja existe usuario com este e-mail.", 409, "CONFLICT");
    }
    throw error;
  }

  return {
    user,
    tempPassword,
  };
}

export async function updateUserAction(input: unknown, session: UserSession | null) {
  assertRole(session, ["admin"]);

  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Payload invalido para atualizacao de usuario.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  if (!parsed.data.role && !parsed.data.status) {
    throw new AppError("Informe ao menos role ou status para atualizacao.", 400, "VALIDATION_ERROR");
  }

  let updated = null;

  if (parsed.data.role) {
    updated = await usersRepository.updateUserRole(parsed.data.id, parsed.data.role);
  }

  if (parsed.data.status) {
    updated = await usersRepository.updateUserStatus(parsed.data.id, parsed.data.status);
  }

  if (!updated) {
    throw new AppError("Usuario nao encontrado.", 404, "NOT_FOUND");
  }

  return updated;
}
