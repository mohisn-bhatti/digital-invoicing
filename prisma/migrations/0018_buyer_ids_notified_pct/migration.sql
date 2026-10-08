-- AlterTable
ALTER TABLE "Buyer" ADD COLUMN     "cnic" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "ntn" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "strn" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "notifiedPct" DECIMAL(5,2) NOT NULL DEFAULT 100;

-- AlterTable
ALTER TABLE "ProductTaxRule" ADD COLUMN     "notifiedPct" DECIMAL(5,2) NOT NULL DEFAULT 100;

-- Existing buyers: a 13-digit number is a CNIC, a 7/9-digit one an NTN
UPDATE "Buyer" SET "cnic" = "ntnCnic" WHERE length("ntnCnic") = 13;
UPDATE "Buyer" SET "ntn" = "ntnCnic" WHERE "ntnCnic" IS NOT NULL AND length("ntnCnic") <> 13;
