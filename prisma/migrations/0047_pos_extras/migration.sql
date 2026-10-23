-- AlterTable
ALTER TABLE "PosItem" ADD COLUMN     "taxInclusive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PosProfile" ADD COLUMN     "logo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "retentionYears" INTEGER NOT NULL DEFAULT 6;

-- AlterTable
ALTER TABLE "PosSaleLine" ADD COLUMN     "taxInclusive" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "PosManualInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "counterId" TEXT,
    "bookNumber" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL,
    "buyerName" TEXT NOT NULL DEFAULT '',
    "buyerPntn" TEXT NOT NULL DEFAULT '',
    "buyerCnic" TEXT NOT NULL DEFAULT '',
    "buyerPhone" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL,
    "paymentMode" INTEGER NOT NULL DEFAULT 1,
    "saleValue" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reportedAt" TIMESTAMP(3),
    "reportedBy" TEXT,
    "reportNote" TEXT NOT NULL DEFAULT '',
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosManualInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosManualInvoice_tenantId_writtenAt_idx" ON "PosManualInvoice"("tenantId", "writtenAt");

-- CreateIndex
CREATE UNIQUE INDEX "PosManualInvoice_tenantId_bookNumber_key" ON "PosManualInvoice"("tenantId", "bookNumber");

-- AddForeignKey
ALTER TABLE "PosManualInvoice" ADD CONSTRAINT "PosManualInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
