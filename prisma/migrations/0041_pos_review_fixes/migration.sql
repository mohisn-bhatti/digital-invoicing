-- DropIndex
DROP INDEX "PosSale_tenantId_state_idx";

-- CreateIndex
CREATE INDEX "PosAttempt_at_idx" ON "PosAttempt"("at");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_state_fiscalizedAt_idx" ON "PosSale"("tenantId", "state", "fiscalizedAt");

