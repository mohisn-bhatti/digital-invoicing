-- CreateEnum
CREATE TYPE "PosEnv" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "PosSaleState" AS ENUM ('DRAFT', 'AWAITING_FISCALIZATION', 'OUTCOME_UNKNOWN', 'FISCALIZED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "posSeq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PosProfile" (
    "tenantId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL DEFAULT '',
    "pntn" TEXT NOT NULL DEFAULT '',
    "address" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "receiptFooter" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosProfile_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "PosBranch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "city" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosBranch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosCounter" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "posId" TEXT NOT NULL,
    "env" "PosEnv" NOT NULL DEFAULT 'SANDBOX',
    "tokenEnc" TEXT,
    "tokenSetAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "pctCode" TEXT NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "taxRateCard" DECIMAL(5,2),
    "unitPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "openPrice" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "counterId" TEXT NOT NULL,
    "invoiceType" INTEGER NOT NULL DEFAULT 1,
    "usin" TEXT NOT NULL,
    "refUsin" TEXT,
    "refSaleId" TEXT,
    "state" "PosSaleState" NOT NULL DEFAULT 'DRAFT',
    "env" "PosEnv" NOT NULL DEFAULT 'SANDBOX',
    "paymentMode" INTEGER NOT NULL,
    "buyerName" TEXT NOT NULL DEFAULT '',
    "buyerPntn" TEXT NOT NULL DEFAULT '',
    "buyerCnic" TEXT NOT NULL DEFAULT '',
    "buyerPhone" TEXT NOT NULL DEFAULT '',
    "totalQuantity" DECIMAL(18,4) NOT NULL,
    "totalSaleValue" DECIMAL(14,2) NOT NULL,
    "totalDiscount" DECIMAL(14,2) NOT NULL,
    "totalTax" DECIMAL(14,2) NOT NULL,
    "totalBill" DECIMAL(14,2) NOT NULL,
    "fiscalNumber" TEXT,
    "lastCode" TEXT,
    "lastError" TEXT,
    "payload" JSONB,
    "response" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "fiscalizedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "PosSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSaleLine" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "itemId" TEXT,
    "itemCode" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "pctCode" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "discount" DECIMAL(14,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "saleValue" DECIMAL(14,2) NOT NULL,
    "taxCharged" DECIMAL(14,2) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "refLineId" TEXT,

    CONSTRAINT "PosSaleLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosSaleEvent" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "by" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosSaleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosAttempt" (
    "id" TEXT NOT NULL,
    "saleId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "code" TEXT,
    "message" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PosAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosBranch_tenantId_name_key" ON "PosBranch"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosCounter_tenantId_name_key" ON "PosCounter"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosCounter_tenantId_posId_key" ON "PosCounter"("tenantId", "posId");

-- CreateIndex
CREATE INDEX "PosItem_tenantId_name_idx" ON "PosItem"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PosItem_tenantId_code_key" ON "PosItem"("tenantId", "code");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_state_idx" ON "PosSale"("tenantId", "state");

-- CreateIndex
CREATE INDEX "PosSale_tenantId_createdAt_idx" ON "PosSale"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PosSale_refSaleId_idx" ON "PosSale"("refSaleId");

-- CreateIndex
CREATE UNIQUE INDEX "PosSale_tenantId_usin_key" ON "PosSale"("tenantId", "usin");

-- CreateIndex
CREATE INDEX "PosSaleLine_saleId_idx" ON "PosSaleLine"("saleId");

-- CreateIndex
CREATE INDEX "PosSaleLine_refLineId_idx" ON "PosSaleLine"("refLineId");

-- CreateIndex
CREATE INDEX "PosSaleEvent_saleId_idx" ON "PosSaleEvent"("saleId");

-- CreateIndex
CREATE INDEX "PosAttempt_saleId_idx" ON "PosAttempt"("saleId");

-- AddForeignKey
ALTER TABLE "PosProfile" ADD CONSTRAINT "PosProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosBranch" ADD CONSTRAINT "PosBranch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCounter" ADD CONSTRAINT "PosCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosCounter" ADD CONSTRAINT "PosCounter_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "PosBranch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosItem" ADD CONSTRAINT "PosItem_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSale" ADD CONSTRAINT "PosSale_counterId_fkey" FOREIGN KEY ("counterId") REFERENCES "PosCounter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleLine" ADD CONSTRAINT "PosSaleLine_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "PosSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosSaleEvent" ADD CONSTRAINT "PosSaleEvent_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "PosSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosAttempt" ADD CONSTRAINT "PosAttempt_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "PosSale"("id") ON DELETE CASCADE ON UPDATE CASCADE;

