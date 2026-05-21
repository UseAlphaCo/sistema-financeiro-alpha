import { Prisma } from '@prisma/client';
import { getPrismaClient } from '@/core/db/prisma-client';

const prisma = getPrismaClient();

function normalizeSnapshotDate(date: Date): Date {
  const key = date.toISOString().slice(0, 10);
  return new Date(`${key}T00:00:00.000Z`);
}

export async function saveDailySnapshot(
  date: Date,
  data: Prisma.InputJsonValue,
  meta: Prisma.InputJsonValue | null = null
) {
  const normalizedDate = normalizeSnapshotDate(date);
  const normalizedMeta = meta ?? Prisma.JsonNull;
  await prisma.dailySnapshot.upsert({
    where: { date: normalizedDate },
    update: { data, generatedAt: new Date(), meta: normalizedMeta },
    create: { date: normalizedDate, data, generatedAt: new Date(), meta: normalizedMeta },
  });
}

export async function getDailySnapshot(date: Date) {
  const normalizedDate = normalizeSnapshotDate(date);
  return prisma.dailySnapshot.findUnique({ where: { date: normalizedDate } });
}

export async function invalidateDailySnapshot(date: Date) {
  const normalizedDate = normalizeSnapshotDate(date);
  await prisma.dailySnapshot.delete({ where: { date: normalizedDate } }).catch(() => {});
}
