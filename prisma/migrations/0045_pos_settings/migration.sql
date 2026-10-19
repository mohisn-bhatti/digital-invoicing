-- AlterTable
ALTER TABLE "PosProfile" ADD COLUMN     "defaultPaymentMode" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "itemCategory" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "itemPct" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "itemTaxRate" DECIMAL(5,2),
ADD COLUMN     "itemTaxRateCard" DECIMAL(5,2),
ADD COLUMN     "receiptHeader" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "receiptWidth" INTEGER NOT NULL DEFAULT 80,
ADD COLUMN     "showCashier" BOOLEAN NOT NULL DEFAULT true;

