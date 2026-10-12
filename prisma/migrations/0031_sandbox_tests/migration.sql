-- Sandbox scenario test invoices sent by the admin's "Run sandbox scenarios" (kept apart from the client's own invoices)
CREATE TABLE "SandboxTest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "stage" TEXT NOT NULL,
    "fbrInvoiceNumber" TEXT,
    "error" TEXT,
    "request" JSONB,
    "response" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SandboxTest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SandboxTest_tenantId_scenarioId_idx" ON "SandboxTest"("tenantId", "scenarioId");
ALTER TABLE "SandboxTest" ADD CONSTRAINT "SandboxTest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
