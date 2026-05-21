import { compare, hash } from "bcryptjs";

import { getPrismaClient } from "@/core/db/prisma-client";
import type {
  CreateUserInput,
  ManagedUserRole,
  UserRecord,
  UserStatus,
} from "@/features/users/types";

function mapUser(item: {
  id: string;
  email: string;
  role: string;
  status: string;
  forcePasswordChange: boolean;
  createdAt: Date;
  updatedAt: Date;
}): UserRecord {
  return {
    id: item.id,
    email: item.email,
    role: item.role as ManagedUserRole,
    status: item.status as UserStatus,
    forcePasswordChange: item.forcePasswordChange,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export async function listUsers(): Promise<UserRecord[]> {
  const prisma = getPrismaClient();
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
  });

  return users.map(mapUser);
}

export async function createUser(input: CreateUserInput, tempPassword: string): Promise<UserRecord> {
  const prisma = getPrismaClient();
  const passwordHash = await hash(tempPassword, 12);

  const user = await prisma.user.create({
    data: {
      email: input.email.trim().toLowerCase(),
      passwordHash,
      role: input.role,
      status: "active",
      forcePasswordChange: true,
    },
  });

  return mapUser(user);
}

export async function updateUserRole(id: string, role: ManagedUserRole): Promise<UserRecord | null> {
  const prisma = getPrismaClient();

  const found = await prisma.user.findUnique({ where: { id } });
  if (!found) return null;

  const user = await prisma.user.update({
    where: { id },
    data: { role },
  });

  return mapUser(user);
}

export async function updateUserStatus(id: string, status: UserStatus): Promise<UserRecord | null> {
  const prisma = getPrismaClient();

  const found = await prisma.user.findUnique({ where: { id } });
  if (!found) return null;

  const user = await prisma.user.update({
    where: { id },
    data: { status },
  });

  return mapUser(user);
}

export async function verifyAndChangePassword(params: {
  userId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<boolean> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({ where: { id: params.userId } });

  if (!user) return false;

  const isCurrentValid = await compare(params.currentPassword, user.passwordHash);
  if (!isCurrentValid) return false;

  const nextHash = await hash(params.newPassword, 12);
  await prisma.user.update({
    where: { id: params.userId },
    data: {
      passwordHash: nextHash,
      forcePasswordChange: false,
    },
  });

  return true;
}
