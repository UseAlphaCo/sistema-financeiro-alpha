-- CreateTable
CREATE TABLE "DailySnapshot" (
    "date" TIMESTAMP(3) NOT NULL,
    "data" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "meta" JSONB,

    CONSTRAINT "DailySnapshot_pkey" PRIMARY KEY ("date")
);
