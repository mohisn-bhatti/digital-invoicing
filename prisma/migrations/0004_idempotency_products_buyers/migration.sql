-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InvoiceStatus" ADD VALUE 'SUBMITTING';
ALTER TYPE "InvoiceStatus" ADD VALUE 'UNCERTAIN';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "clientRequestId" TEXT,
ADD COLUMN     "lastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "submitAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hsCode" TEXT NOT NULL,
    "uoM" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "saleType" TEXT NOT NULL,
    "unitPrice" DECIMAL(14,2),
    "sroScheduleNo" TEXT NOT NULL DEFAULT '',
    "sroItemSerialNo" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Buyer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "ntnCnic" TEXT,
    "registrationType" TEXT NOT NULL DEFAULT 'Unregistered',
    "province" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Buyer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Product_tenantId_name_key" ON "Product"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Buyer_tenantId_businessName_idx" ON "Buyer"("tenantId", "businessName");

-- CreateIndex
CREATE UNIQUE INDEX "Buyer_tenantId_ntnCnic_key" ON "Buyer"("tenantId", "ntnCnic");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_clientRequestId_key" ON "Invoice"("tenantId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Buyer" ADD CONSTRAINT "Buyer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

