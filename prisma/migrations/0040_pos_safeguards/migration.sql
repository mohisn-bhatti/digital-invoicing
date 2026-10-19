-- AlterTable
ALTER TABLE "PosAttempt" ADD COLUMN     "mock" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PosSale" ADD COLUMN     "clientRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_tenantId_clientRef_key" ON "PosSale"("tenantId", "clientRef");

