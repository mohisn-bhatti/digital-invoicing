-- CreateEnum
CREATE TYPE "PosCashKind" AS ENUM ('RECEIPT', 'PAYMENT');

-- AlterTable
ALTER TABLE "PosCustomer" ADD COLUMN     "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PosVendor" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ntn" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "openingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosVendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPurchase" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vendorId" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "vendorRef" TEXT NOT NULL DEFAULT '',
    "billDate" DATE NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosPurchaseLine" (
    "id" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCost" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PosPurchaseLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosCashEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "PosCashKind" NOT NULL,
    "number" TEXT NOT NULL,
    "entryDate" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'CASH',
    "reference" TEXT NOT NULL DEFAULT '',
    "customerId" TEXT,
    "vendorId" TEXT,
    "purchaseId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosCashEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosVendor_tenantId_name_idx" ON "PosVendor"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosVendor_tenantId_code_key" ON "PosVendor"("tenantId", "code");

-- CreateIndex
CREATE INDEX "PosPurchase_tenantId_billDate_idx" ON "PosPurchase"("tenantId", "billDate");

-- CreateIndex
CREATE INDEX "PosPurchase_tenantId_vendorId_idx" ON "PosPurchase"("tenantId", "vendorId");

-- CreateIndex
CREATE UNIQUE INDEX "PosPurchase_tenantId_number_key" ON "PosPurchase"("tenantId", "number");

-- CreateIndex
CREATE INDEX "PosPurchaseLine_purchaseId_idx" ON "PosPurchaseLine"("purchaseId");

-- CreateIndex
CREATE INDEX "PosCashEntry_tenantId_kind_entryDate_idx" ON "PosCashEntry"("tenantId", "kind", "entryDate");

-- CreateIndex
CREATE INDEX "PosCashEntry_tenantId_customerId_idx" ON "PosCashEntry"("tenantId", "customerId");

-- CreateIndex
CREATE INDEX "PosCashEntry_tenantId_vendorId_idx" ON "PosCashEntry"("tenantId", "vendorId");

-- CreateIndex
CREATE INDEX "PosCashEntry_purchaseId_idx" ON "PosCashEntry"("purchaseId");

-- CreateIndex
CREATE UNIQUE INDEX "PosCashEntry_tenantId_number_key" ON "PosCashEntry"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "PosVendor" ADD CONSTRAINT "PosVendor_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPurchase" ADD CONSTRAINT "PosPurchase_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPurchase" ADD CONSTRAINT "PosPurchase_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "PosVendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPurchaseLine" ADD CONSTRAINT "PosPurchaseLine_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PosPurchase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCashEntry" ADD CONSTRAINT "PosCashEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCashEntry" ADD CONSTRAINT "PosCashEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "PosCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCashEntry" ADD CONSTRAINT "PosCashEntry_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "PosVendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCashEntry" ADD CONSTRAINT "PosCashEntry_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PosPurchase"("id") ON DELETE SET NULL ON UPDATE CASCADE;
