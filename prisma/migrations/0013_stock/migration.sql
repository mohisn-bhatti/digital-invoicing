-- CreateEnum
CREATE TYPE "StockEntryType" AS ENUM ('OPENING', 'PURCHASE', 'IMPORT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- CreateTable
CREATE TABLE "StockEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entryType" "StockEntryType" NOT NULL,
    "entryDate" TEXT NOT NULL,
    "hsCode" TEXT NOT NULL,
    "uoM" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "quantity" DECIMAL(18,4) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL DEFAULT '',
    "partyName" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockEntry_tenantId_entryDate_idx" ON "StockEntry"("tenantId", "entryDate");

-- CreateIndex
CREATE INDEX "StockEntry_tenantId_hsCode_idx" ON "StockEntry"("tenantId", "hsCode");

-- AddForeignKey
ALTER TABLE "StockEntry" ADD CONSTRAINT "StockEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

