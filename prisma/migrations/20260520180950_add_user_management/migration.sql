-- CreateEnum
CREATE TYPE "UserAccountRole" AS ENUM ('admin', 'financeiro');

-- CreateEnum
CREATE TYPE "UserAccountStatus" AS ENUM ('active', 'disabled');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserAccountRole" NOT NULL DEFAULT 'financeiro',
    "status" "UserAccountStatus" NOT NULL DEFAULT 'active',
    "forcePasswordChange" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");
