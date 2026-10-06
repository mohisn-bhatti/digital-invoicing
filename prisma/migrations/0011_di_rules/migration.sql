-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "authLetterAt" TIMESTAMP(3),
ADD COLUMN     "authLetterRef" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "invoiceNumberFormat" TEXT NOT NULL DEFAULT 'INV-{YYYY}-{NNNN}',
ADD COLUMN     "softwareRegNo" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "buyerNonAtl" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "invoiceNo" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "offlineMode" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offlineSince" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InvoiceItem" ALTER COLUMN "unitPrice" SET DATA TYPE DECIMAL(18,6);


-- Existing invoices: use the plain number as their internal invoice no.
UPDATE "Invoice" SET "invoiceNo" = "localNo"::text WHERE "invoiceNo" = '';
