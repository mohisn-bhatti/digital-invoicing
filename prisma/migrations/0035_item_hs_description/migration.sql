-- The HS code's description on each item: FBR's own text for an official code, the client's for a code they created
ALTER TABLE "Product" ADD COLUMN "hsDescription" TEXT NOT NULL DEFAULT '';
UPDATE "Product" p SET "hsDescription" = h."description" FROM "HsCode" h WHERE h."code" = p."hsCode";
