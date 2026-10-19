-- AlterTable
ALTER TABLE "PosItem" ADD COLUMN     "barcode" TEXT;

-- AlterTable
ALTER TABLE "PosSale" ADD COLUMN     "customerId" TEXT;

-- AlterTable
ALTER TABLE "PosSaleLine" ADD COLUMN     "category" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "PosCustomer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pntn" TEXT NOT NULL DEFAULT '',
    "cnic" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosCustomer_tenantId_name_idx" ON "PosCustomer"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosCustomer_tenantId_code_key" ON "PosCustomer"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PosItem_tenantId_barcode_key" ON "PosItem"("tenantId", "barcode");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_customerId_idx" ON "PosSale"("tenantId", "customerId");

-- AddForeignKey
ALTER TABLE "PosCustomer" ADD CONSTRAINT "PosCustomer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "PosCustomer"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Sales made before this: the category the item has now is the best that is known (only the new column is filled in)
UPDATE "PosSaleLine" l SET "category" = i."category" FROM "PosItem" i WHERE l."itemId" = i."id" AND l."category" = '';
