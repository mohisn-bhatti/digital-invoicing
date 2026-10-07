-- One HS code can have several rules, each with a condition (e.g. loose vs branded retail packing)
ALTER TABLE "HsTaxRule" ADD COLUMN "condition" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HsTaxRule" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "HsTaxRule" ADD COLUMN "reviewed" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "HsTaxRule_prefix_key";
CREATE UNIQUE INDEX "HsTaxRule_prefix_condition_key" ON "HsTaxRule"("prefix", "condition");
CREATE INDEX "HsTaxRule_prefix_idx" ON "HsTaxRule"("prefix");

-- The 0014 starting rules came from the CA's Document 1 examples, not the Act itself
UPDATE "HsTaxRule" SET "source" = 'CA Document 1 (examples)';
UPDATE "HsTaxRule" SET "source" = 'own assumption — not in Document 1' WHERE "prefix" = '23091000';
