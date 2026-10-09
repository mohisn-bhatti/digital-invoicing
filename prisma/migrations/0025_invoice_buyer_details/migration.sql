-- The invoice keeps all the buyer's details (CA: same fields as the Buyers page). FBR still gets one number,
-- buyerNtnCnic = the NTN if there is one, else the CNIC.
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "buyerNtn" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "buyerCnic" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "buyerStrn" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "buyerMobile" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "buyerEmail" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "buyerNote" TEXT NOT NULL DEFAULT '';
