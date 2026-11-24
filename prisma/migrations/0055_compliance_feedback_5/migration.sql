-- AlterTable
ALTER TABLE "CmpAdvance" ADD COLUMN     "method" TEXT NOT NULL DEFAULT 'BANK',
ADD COLUMN     "number" TEXT,
ADD COLUMN     "reference" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "seqNo" INTEGER,
ADD COLUMN     "typeId" TEXT,
ADD COLUMN     "typeSnapshot" JSONB;

-- AlterTable
ALTER TABLE "CmpInvoice" ADD COLUMN     "charges" DECIMAL(14,3) NOT NULL DEFAULT 0,
ADD COLUMN     "discount" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CmpItem" ADD COLUMN     "category" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "code" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "unit" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "CmpMessage" ADD COLUMN     "advanceId" TEXT;

-- AlterTable
ALTER TABLE "CmpReminder" ADD COLUMN     "rejectedVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "templateVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CmpSettings" ADD COLUMN     "advanceFormat" TEXT NOT NULL DEFAULT 'ADV-{YYYY}-{NNNN}',
ADD COLUMN     "advanceSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dateFormat" TEXT NOT NULL DEFAULT 'D MMM YYYY',
ADD COLUMN     "firmCity" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "firmCountry" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "firmWebsite" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "holidayMode" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "holidays" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "notifyHour" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "notifyPrefs" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "notifyRules" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "numberFormat" TEXT NOT NULL DEFAULT '1,234.56',
ADD COLUMN     "sessionMinutes" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "weekendDays" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "CmpTaxRate" ADD COLUMN     "effectiveFrom" DATE,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "CmpTemplate" ADD COLUMN     "country" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1,
ALTER COLUMN "purpose" SET DEFAULT 'REMINDER_1';

-- CreateTable
CREATE TABLE "CmpObligationTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "body" TEXT,
    "templateVersion" INTEGER NOT NULL DEFAULT 0,
    "rejectedVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmpObligationTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpNotification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "userId" TEXT,
    "clientId" TEXT,
    "obligationId" TEXT,
    "occurrenceId" TEXT,
    "invoiceId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "forDay" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readBy" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'DONE',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CmpNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmpObligationTemplate_templateId_idx" ON "CmpObligationTemplate"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpObligationTemplate_obligationId_kind_key" ON "CmpObligationTemplate"("obligationId", "kind");

-- CreateIndex
CREATE INDEX "CmpNotification_tenantId_createdAt_idx" ON "CmpNotification"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CmpNotification_tenantId_forDay_idx" ON "CmpNotification"("tenantId", "forDay");

-- CreateIndex
CREATE INDEX "CmpNotification_occurrenceId_idx" ON "CmpNotification"("occurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpNotification_tenantId_key_key" ON "CmpNotification"("tenantId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CmpAdvance_tenantId_number_key" ON "CmpAdvance"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "CmpObligationTemplate" ADD CONSTRAINT "CmpObligationTemplate_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "CmpObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpObligationTemplate" ADD CONSTRAINT "CmpObligationTemplate_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CmpTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "CmpAdvance"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill (new columns only): the advances recorded before get their receipt numbers, in the order they were recorded, one series per
-- firm (ADV-YYYY-NNNN, the year of the day received), and the firm's counter starts after them. (The templates of before keep their
-- category value: "Data collection" and "Obligation completed" are shown and used as "Others" by the code, "Reminder" until it is chosen.)
WITH n AS (
    SELECT id, "receivedOn", row_number() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", id) AS rn FROM "CmpAdvance"
)
UPDATE "CmpAdvance" a SET "seqNo" = n.rn, "number" = 'ADV-' || to_char(n."receivedOn", 'YYYY') || '-' || lpad(n.rn::text, 4, '0')
FROM n WHERE a.id = n.id AND a."seqNo" IS NULL;
UPDATE "CmpSettings" s SET "advanceSeq" = c.cnt
FROM (SELECT "tenantId", count(*)::int AS cnt FROM "CmpAdvance" GROUP BY "tenantId") c
WHERE s."tenantId" = c."tenantId" AND s."advanceSeq" < c.cnt;
