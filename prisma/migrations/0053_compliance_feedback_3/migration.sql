-- AlterTable
ALTER TABLE "CmpInvoice" ADD COLUMN     "advanceAdjusted" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "advanceUse" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "typeId" TEXT,
ADD COLUMN     "typeSnapshot" JSONB;

-- AlterTable
ALTER TABLE "CmpInvoiceLine" ADD COLUMN     "bankName" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "occurrenceId" TEXT;

-- AlterTable
ALTER TABLE "CmpOccurrence" ADD COLUMN     "completedOn" DATE,
ADD COLUMN     "dataCollectedBy" TEXT,
ADD COLUMN     "dataCollectedOn" DATE;

-- AlterTable
ALTER TABLE "CmpReminder" ADD COLUMN     "body" TEXT,
ALTER COLUMN "templateId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "CmpItemPrice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "firstOn" DATE NOT NULL,
    "lastOn" DATE NOT NULL,
    "uses" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CmpItemPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpAdvance" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "receivedOn" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "used" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CmpAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpInvoiceType" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "layout" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpInvoiceType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CmpItemPrice_itemId_amount_key" ON "CmpItemPrice"("itemId", "amount");

-- CreateIndex
CREATE INDEX "CmpAdvance_tenantId_clientId_idx" ON "CmpAdvance"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "CmpAdvance_occurrenceId_idx" ON "CmpAdvance"("occurrenceId");

-- CreateIndex
CREATE INDEX "CmpInvoiceType_tenantId_country_idx" ON "CmpInvoiceType"("tenantId", "country");

-- CreateIndex
CREATE UNIQUE INDEX "CmpInvoiceType_tenantId_name_key" ON "CmpInvoiceType"("tenantId", "name");

-- CreateIndex
CREATE INDEX "CmpInvoiceLine_occurrenceId_idx" ON "CmpInvoiceLine"("occurrenceId");

-- AddForeignKey
ALTER TABLE "CmpItemPrice" ADD CONSTRAINT "CmpItemPrice_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "CmpItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpAdvance" ADD CONSTRAINT "CmpAdvance_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpAdvance" ADD CONSTRAINT "CmpAdvance_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "CmpClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpAdvance" ADD CONSTRAINT "CmpAdvance_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "CmpOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpInvoiceType" ADD CONSTRAINT "CmpInvoiceType_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing periods: a step past "Open" means the data was collected; a completed one has its task date (the day it was closed)
UPDATE "CmpOccurrence" SET "dataCollectedOn" = COALESCE("closedAt", "updatedAt")::date, "dataCollectedBy" = COALESCE("closedBy", '')
  WHERE "stage" IN ('DATA_COLLECTED', 'FILED', 'PAID', 'COMPLETED') AND "dataCollectedOn" IS NULL;
UPDATE "CmpOccurrence" SET "completedOn" = COALESCE("closedAt", "updatedAt")::date WHERE "stage" = 'COMPLETED' AND "completedOn" IS NULL;

-- The price bank starts with each saved item's current price
INSERT INTO "CmpItemPrice" ("id", "tenantId", "itemId", "amount", "firstOn", "lastOn", "uses", "createdBy")
  SELECT gen_random_uuid()::text, "tenantId", "id", "amount", "updatedAt"::date, "updatedAt"::date, 1, "createdBy" FROM "CmpItem"
  ON CONFLICT ("itemId", "amount") DO NOTHING;

-- An invoice made for one period: its first line bills that period
UPDATE "CmpInvoiceLine" l SET "occurrenceId" = i."occurrenceId"
  FROM "CmpInvoice" i WHERE l."invoiceId" = i."id" AND i."occurrenceId" IS NOT NULL AND l."occurrenceId" IS NULL AND l."sortOrder" = 0;
