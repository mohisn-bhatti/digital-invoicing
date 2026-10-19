-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "accessCount" INTEGER,
ADD COLUMN     "accessEndsAt" TIMESTAMP(3),
ADD COLUMN     "accessUnit" TEXT,
ADD COLUMN     "inactiveReason" TEXT,
ADD COLUMN     "integratedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;


-- Clients that existed before this: integrated the day they were registered, with no time limit; the ones already switched off
-- were switched off by hand.
UPDATE "Tenant" SET "integratedAt" = "createdAt";
UPDATE "Tenant" SET "inactiveReason" = 'ADMIN' WHERE "active" = false;
