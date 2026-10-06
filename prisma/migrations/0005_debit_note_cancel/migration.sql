-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "cancelNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "reason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "reasonRemarks" TEXT NOT NULL DEFAULT '';

