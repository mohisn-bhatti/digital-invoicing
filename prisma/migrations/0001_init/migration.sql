-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'CLIENT_USER');

-- CreateEnum
CREATE TYPE "FbrEnv" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'CLIENT_USER',
    "tenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "sellerNtnCnic" TEXT NOT NULL DEFAULT '',
    "sellerBusinessName" TEXT NOT NULL DEFAULT '',
    "sellerProvince" TEXT NOT NULL DEFAULT '',
    "sellerAddress" TEXT NOT NULL DEFAULT '',
    "fbrTokenEnc" TEXT,
    "fbrEnv" "FbrEnv" NOT NULL DEFAULT 'SANDBOX',
    "furtherTaxRate" DECIMAL(5,2) NOT NULL DEFAULT 4,
    "invoiceSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "localNo" INTEGER NOT NULL,
    "fbrInvoiceNumber" TEXT,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "fbrEnv" "FbrEnv" NOT NULL,
    "invoiceType" TEXT NOT NULL DEFAULT 'Sale Invoice',
    "invoiceDate" TEXT NOT NULL,
    "invoiceRefNo" TEXT NOT NULL DEFAULT '',
    "scenarioId" TEXT,
    "buyerNtnCnic" TEXT NOT NULL DEFAULT '',
    "buyerBusinessName" TEXT NOT NULL,
    "buyerProvince" TEXT NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "buyerRegistrationType" TEXT NOT NULL,
    "totalExclST" DECIMAL(14,2) NOT NULL,
    "totalST" DECIMAL(14,2) NOT NULL,
    "totalFurtherTax" DECIMAL(14,2) NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "fbrRequest" JSONB,
    "fbrResponse" JSONB,
    "errorMessage" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceItem" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "sNo" INTEGER NOT NULL,
    "hsCode" TEXT NOT NULL,
    "productDescription" TEXT NOT NULL,
    "rate" TEXT NOT NULL,
    "uoM" TEXT NOT NULL,
    "quantity" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "valueSalesExcludingST" DECIMAL(14,2) NOT NULL,
    "fixedNotifiedValueOrRetailPrice" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "salesTaxApplicable" DECIMAL(14,2) NOT NULL,
    "salesTaxWithheldAtSource" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "extraTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "furtherTax" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "fedPayable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "totalValues" DECIMAL(14,2) NOT NULL,
    "saleType" TEXT NOT NULL,
    "sroScheduleNo" TEXT NOT NULL DEFAULT '',
    "sroItemSerialNo" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_fbrInvoiceNumber_key" ON "Invoice"("fbrInvoiceNumber");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_createdAt_idx" ON "Invoice"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_tenantId_localNo_key" ON "Invoice"("tenantId", "localNo");

-- CreateIndex
CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

