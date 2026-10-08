-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'OFFICIAL',
ADD COLUMN     "taxRuleAt" TIMESTAMP(3),
ALTER COLUMN "rate" SET DEFAULT '',
ALTER COLUMN "saleType" SET DEFAULT '';

-- CreateTable
CREATE TABLE "ProductTaxRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "saleType" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "sroScheduleNo" TEXT NOT NULL DEFAULT '',
    "sroItemSerialNo" TEXT NOT NULL DEFAULT '',
    "industry" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductTaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductTaxRule_productId_createdAt_idx" ON "ProductTaxRule"("productId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProductTaxRule" ADD CONSTRAINT "ProductTaxRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Products saved before this change already carry a sale type and rate: keep them as each item's first tax rule
INSERT INTO "ProductTaxRule" ("id", "tenantId", "productId", "saleType", "rate", "sroScheduleNo", "sroItemSerialNo", "createdBy", "createdAt")
SELECT gen_random_uuid()::text, "tenantId", "id", "saleType", "rate", "sroScheduleNo", "sroItemSerialNo", 'saved before tax rules', "updatedAt"
FROM "Product" WHERE "saleType" <> '' AND "rate" <> '';
UPDATE "Product" SET "taxRuleAt" = "updatedAt" WHERE "saleType" <> '' AND "rate" <> '';
