-- AlterTable
ALTER TABLE "CmpInvoice" ADD COLUMN     "cancelSettlement" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "CmpMessage" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'WHATSAPP';

-- AlterTable
ALTER TABLE "CmpReceipt" ADD COLUMN     "creditUsed" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "settledBy" TEXT,
ADD COLUMN     "settlement" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "settlementNote" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "CmpSettings" ADD COLUMN     "headerStyle" TEXT NOT NULL DEFAULT 'LOGO',
ADD COLUMN     "letterhead" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "CmpCredit" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "used" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "fromInvoiceId" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmpCredit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmpCredit_tenantId_clientId_currency_idx" ON "CmpCredit"("tenantId", "clientId", "currency");

-- AddForeignKey
ALTER TABLE "CmpCredit" ADD CONSTRAINT "CmpCredit_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpCredit" ADD CONSTRAINT "CmpCredit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "CmpClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
