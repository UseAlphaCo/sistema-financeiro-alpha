-- AlterTable
ALTER TABLE "FinancialTransaction" ADD COLUMN     "discountCents" INTEGER DEFAULT 0,
ADD COLUMN     "feeCents" INTEGER DEFAULT 0,
ADD COLUMN     "shippingCents" INTEGER DEFAULT 0,
ADD COLUMN     "taxCents" INTEGER DEFAULT 0;
