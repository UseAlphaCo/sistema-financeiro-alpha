import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";

import { assertRole } from "@/core/auth/guards";
import { AppError } from "@/core/errors/app-error";
import * as usersRepository from "@/features/users/repository";
import { createUserSchema, deleteUserSchema, resetUserPasswordSchema, updateUserSchema } from "@/features/users/validations";
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

export async function deleteUserAction(input: unknown, session: UserSession | null) {
  assertRole(session, ["admin"]);

  const parsed = deleteUserSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Payload invalido para exclusao de usuario.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  if (parsed.data.id === session.id) {
    throw new AppError("Nao e permitido excluir sua propria conta.", 400, "SELF_DELETE_FORBIDDEN");
  }

  const existing = await usersRepository.findUserById(parsed.data.id);
  if (!existing) {
    throw new AppError("Usuario nao encontrado.", 404, "NOT_FOUND");
  }

  if (existing.role === "admin" && existing.status === "active") {
    const activeAdmins = await usersRepository.countActiveAdmins();
    if (activeAdmins <= 1) {
      throw new AppError("Nao e permitido excluir o ultimo admin ativo.", 400, "LAST_ADMIN_FORBIDDEN");
    }
  }

  const deleted = await usersRepository.deleteUserById(parsed.data.id);
  if (!deleted) {
    throw new AppError("Usuario nao encontrado.", 404, "NOT_FOUND");
  }

  return deleted;
}

export async function resetUserPasswordAction(input: unknown, session: UserSession | null) {
  assertRole(session, ["admin"]);

  const parsed = resetUserPasswordSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("Payload invalido para redefinicao de senha.", 400, "VALIDATION_ERROR", parsed.error.flatten());
  }

  if (parsed.data.id === session.id) {
    throw new AppError("Use a tela de alterar senha para atualizar sua propria senha.", 400, "SELF_PASSWORD_RESET_FORBIDDEN");
  }

  const existing = await usersRepository.findUserById(parsed.data.id);
  if (!existing) {
    throw new AppError("Usuario nao encontrado.", 404, "NOT_FOUND");
  }

  if (parsed.data.mode === "generated") {
    const tempPassword = generateTempPassword();
    const user = await usersRepository.updateUserPassword({
      userId: parsed.data.id,
      newPassword: tempPassword,
      forcePasswordChange: true,
    });

    if (!user) {
      throw new AppError("Usuario nao encontrado.", 404, "NOT_FOUND");
    }

    return {
      user,
      mode: "generated" as const,
      tempPassword,
    };
  }

  const user = await usersRepository.updateUserPassword({
    userId: parsed.data.id,
    newPassword: parsed.data.newPassword,
    forcePasswordChange: true,
  });

  if (!user) {
    throw new AppError("Usuario nao encontrado.", 404, "NOT_FOUND");
  }

  return {
    user,
    mode: "manual" as const,
  };
}
