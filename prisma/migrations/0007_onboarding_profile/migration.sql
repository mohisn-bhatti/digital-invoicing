-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "businessActivities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "sector" TEXT NOT NULL DEFAULT '';

