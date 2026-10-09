-- One comment per tax (CA): the sales tax row's comment lives in "taxComment"; each more tax keeps its own
-- references and comment inside "extraTaxes". Comments written per reference so far are merged into taxComment.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "taxComment" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ProductTaxRule" ADD COLUMN     "taxComment" TEXT NOT NULL DEFAULT '';

UPDATE "Product" p SET "taxComment" = c.txt FROM (
  SELECT id, string_agg((e->>'reference') || ': ' || (e->>'comment'), E'\n') AS txt
  FROM "Product", jsonb_array_elements("lawRefs") e WHERE coalesce(e->>'comment', '') <> '' GROUP BY id
) c WHERE p.id = c.id;
UPDATE "ProductTaxRule" p SET "taxComment" = c.txt FROM (
  SELECT id, string_agg((e->>'reference') || ': ' || (e->>'comment'), E'\n') AS txt
  FROM "ProductTaxRule", jsonb_array_elements("lawRefs") e WHERE coalesce(e->>'comment', '') <> '' GROUP BY id
) c WHERE p.id = c.id;
