-- AlterTable
ALTER TABLE "FinancialTransaction" ADD COLUMN     "marketplace" TEXT,
ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "paymentMethodNormalized" TEXT,
ADD COLUMN     "paymentMethodRaw" TEXT;

-- CreateIndex
CREATE INDEX "FinancialTransaction_marketplace_idx" ON "FinancialTransaction"("marketplace");

-- CreateIndex
CREATE INDEX "FinancialTransaction_paymentMethodNormalized_idx" ON "FinancialTransaction"("paymentMethodNormalized");

-- CreateIndex
CREATE INDEX "FinancialTransaction_orderNumber_idx" ON "FinancialTransaction"("orderNumber");
