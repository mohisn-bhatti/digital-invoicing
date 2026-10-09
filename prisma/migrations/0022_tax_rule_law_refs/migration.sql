-- Several references per tax rule, each with the user's comment on the law (CA). The first is sent to FBR as the
-- SRO / Schedule no. Existing rules get their one reference as the first row.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lawRefs" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ProductTaxRule" ADD COLUMN     "lawRefs" JSONB NOT NULL DEFAULT '[]';

UPDATE "Product" SET "lawRefs" = jsonb_build_array(jsonb_build_object('reference', "sroScheduleNo", 'url', '', 'source', '', 'comment', ''))
WHERE "sroScheduleNo" <> '';
UPDATE "ProductTaxRule" SET "lawRefs" = jsonb_build_array(jsonb_build_object('reference', "sroScheduleNo", 'url', '', 'source', '', 'comment', ''))
WHERE "sroScheduleNo" <> '';
