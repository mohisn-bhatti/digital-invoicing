-- FBR DI API v1.12 chain: the rate chosen from SaleTypeToRate (§5.8) and the SRO chosen from SroSchedule (§5.7)
-- are kept by id, so the SRO item list (§5.10) can be loaded again when the item is edited.
-- tokenIssuedAt: FBR tokens are valid for 5 years (§3.1) — used for a reminder before they expire.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "fbrRateId" INTEGER,
ADD COLUMN     "fbrSroId" INTEGER;
ALTER TABLE "ProductTaxRule" ADD COLUMN     "fbrRateId" INTEGER,
ADD COLUMN     "fbrSroId" INTEGER;
ALTER TABLE "Tenant" ADD COLUMN     "tokenIssuedAt" TIMESTAMP(3);
