-- Notified value is a price per unit (CA: "sugar sells at 150/kg, notified rate 140/kg → tax on 140"), not a %.
-- notifiedPct (added the day before, default 100) is replaced by notifiedRate.
-- AlterTable
ALTER TABLE "Product" DROP COLUMN "notifiedPct",
ADD COLUMN     "notifiedRate" DECIMAL(14,2),
ADD COLUMN     "prices" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "ProductTaxRule" DROP COLUMN "notifiedPct",
ADD COLUMN     "notifiedRate" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "LegalReference" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "refNo" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL,
    "issuedOn" TIMESTAMP(3),
    "url" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalReference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalReference_source_issuedOn_idx" ON "LegalReference"("source", "issuedOn");

-- CreateIndex
CREATE UNIQUE INDEX "LegalReference_source_url_key" ON "LegalReference"("source", "url");


-- Items saved with one price keep it as their first price
UPDATE "Product" SET "prices" = jsonb_build_array(jsonb_build_object('label', 'Price', 'price', "unitPrice")) WHERE "unitPrice" IS NOT NULL;
