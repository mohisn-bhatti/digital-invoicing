-- IRIS lets several sectors be ticked: one list instead of a single value
ALTER TABLE "Tenant" ADD COLUMN "sectors" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "Tenant" SET "sectors" = ARRAY["sector"] WHERE "sector" <> '';
ALTER TABLE "Tenant" DROP COLUMN "sector";
