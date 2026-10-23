-- CreateTable
CREATE TABLE "PosImportBatch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "added" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "addedIds" JSONB NOT NULL,
    "changes" JSONB NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "undoneBy" TEXT,
    "undoNote" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosImportBatch_tenantId_createdAt_idx" ON "PosImportBatch"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "PosImportBatch" ADD CONSTRAINT "PosImportBatch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
