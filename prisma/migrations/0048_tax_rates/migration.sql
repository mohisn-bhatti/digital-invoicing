-- AlterTable
ALTER TABLE "PosItem" ADD COLUMN     "followSchedule" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "authority" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rate" DECIMAL(5,2) NOT NULL,
    "cardRate" DECIMAL(5,2),
    "conditions" TEXT NOT NULL DEFAULT '',
    "effectiveFrom" DATE NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT '',
    "sourceRef" TEXT NOT NULL DEFAULT '',
    "sourceUrl" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxRate_authority_code_effectiveFrom_idx" ON "TaxRate"("authority", "code", "effectiveFrom");

-- The five rates this application has always suggested, put in the schedule as of 1 July 2026 (Finance Act 2026). They are only as good as the
-- reading of the Act they came from: the super admin checks them against PRA's own copy and adds the rest of the Second Schedule.
INSERT INTO "TaxRate" ("id", "authority", "code", "label", "rate", "cardRate", "conditions", "effectiveFrom", "sourceName", "sourceRef", "note", "createdBy") VALUES (gen_random_uuid()::text, 'PRA', '98012000', 'Services provided or rendered by restaurants', 16, 8, '8% when the customer pays by debit or credit card, mobile wallet or QR (it was 5% until 30 June 2026, Punjab Finance Act 2026)', DATE '2026-07-01', 'Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)', 'Second Schedule', 'First entered with the schedule; re-check against PRA''s copy', 'system');
INSERT INTO "TaxRate" ("id", "authority", "code", "label", "rate", "cardRate", "conditions", "effectiveFrom", "sourceName", "sourceRef", "note", "createdBy") VALUES (gen_random_uuid()::text, 'PRA', '98011000', 'Services provided or rendered by hotels', 16, 8, '8% when the customer pays by debit or credit card, mobile wallet or QR', DATE '2026-07-01', 'Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)', 'Second Schedule', 'First entered with the schedule; re-check against PRA''s copy', 'system');
INSERT INTO "TaxRate" ("id", "authority", "code", "label", "rate", "cardRate", "conditions", "effectiveFrom", "sourceName", "sourceRef", "note", "createdBy") VALUES (gen_random_uuid()::text, 'PRA', '98013000', 'Services provided or rendered by marriage halls and lawns', 8, NULL, '', DATE '2026-07-01', 'Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)', 'Second Schedule', 'First entered with the schedule; re-check against PRA''s copy', 'system');
INSERT INTO "TaxRate" ("id", "authority", "code", "label", "rate", "cardRate", "conditions", "effectiveFrom", "sourceName", "sourceRef", "note", "createdBy") VALUES (gen_random_uuid()::text, 'PRA', '98015000', 'Services provided or rendered by caterers and event management', 8, NULL, '', DATE '2026-07-01', 'Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)', 'Second Schedule', 'First entered with the schedule; re-check against PRA''s copy', 'system');
INSERT INTO "TaxRate" ("id", "authority", "code", "label", "rate", "cardRate", "conditions", "effectiveFrom", "sourceName", "sourceRef", "note", "createdBy") VALUES (gen_random_uuid()::text, 'PRA', '98100000', 'Services provided or rendered by beauty parlours and salons', 5, NULL, '', DATE '2026-07-01', 'Punjab Sales Tax on Services Act 2012, Second Schedule (17th edition, 2026-27)', 'Second Schedule', 'First entered with the schedule; re-check against PRA''s copy', 'system');
