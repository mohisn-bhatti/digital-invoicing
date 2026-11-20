-- AlterTable
ALTER TABLE "CmpInvoiceType" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'INVOICE';

-- AlterTable
ALTER TABLE "CmpObligation" ADD COLUMN     "locked" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CmpOccurrence" ADD COLUMN     "dataNote" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "taskNote" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "CmpReceipt" ADD COLUMN     "typeId" TEXT,
ADD COLUMN     "typeSnapshot" JSONB;
