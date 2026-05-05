import { PrismaClient } from "@prisma/client";

const globalStore = globalThis as typeof globalThis & {
  __prismaClient?: PrismaClient;
};

export function getPrismaClient() {
  if (!globalStore.__prismaClient) {
    globalStore.__prismaClient = new PrismaClient();
  }

  return globalStore.__prismaClient;
}
