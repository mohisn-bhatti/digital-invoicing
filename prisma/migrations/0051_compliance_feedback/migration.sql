-- AlterTable
ALTER TABLE "CmpClient" ADD COLUMN     "noWhatsApp" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CmpObligation" ADD COLUMN     "amberDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "autoNext" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CmpSettings" ADD COLUMN     "invoiceHeader" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "logo" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "CmpItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "allCountries" BOOLEAN NOT NULL DEFAULT false,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CmpItem_tenantId_key_currency_key" ON "CmpItem"("tenantId", "key", "currency");

-- AddForeignKey
ALTER TABLE "CmpItem" ADD CONSTRAINT "CmpItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The amber days and "prepare the next period by itself" move from the firm's settings to each obligation (the CA, 9 Nov 2026):
-- the obligations already there keep what their firm had chosen
UPDATE "CmpObligation" o SET "amberDays" = s."amberDays", "autoNext" = s."autoNextYear"
FROM "CmpSettings" s WHERE s."tenantId" = o."tenantId";
