-- Compliance & Deadlines module: its own tables (clients, obligations, reminders, templates, WhatsApp log, fee invoices, receipts, taxes),
-- plus the users' permissions in it. Only additions: nothing existing changes.
-- CreateEnum
CREATE TYPE "CmpStage" AS ENUM ('OPEN', 'DATA_COLLECTED', 'FILED', 'PAID', 'COMPLETED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cmpPerms" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "CmpSettings" (
    "tenantId" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL DEFAULT 'Asia/Karachi',
    "reminderHour" INTEGER NOT NULL DEFAULT 9,
    "amberDays" INTEGER NOT NULL DEFAULT 7,
    "autoNextYear" BOOLEAN NOT NULL DEFAULT true,
    "waSenders" JSONB NOT NULL DEFAULT '[]',
    "firmName" TEXT NOT NULL DEFAULT '',
    "firmAddress" TEXT NOT NULL DEFAULT '',
    "firmPhone" TEXT NOT NULL DEFAULT '',
    "firmEmail" TEXT NOT NULL DEFAULT '',
    "firmTaxNo" TEXT NOT NULL DEFAULT '',
    "bankDetails" TEXT NOT NULL DEFAULT '',
    "invoiceFooter" TEXT NOT NULL DEFAULT '',
    "invoiceFormat" TEXT NOT NULL DEFAULT 'INV-{YYYY}-{NNNN}',
    "receiptFormat" TEXT NOT NULL DEFAULT 'RCT-{YYYY}-{NNNN}',
    "invoiceSeq" INTEGER NOT NULL DEFAULT 0,
    "receiptSeq" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpSettings_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "CmpClient" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL DEFAULT '',
    "contactNumber" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "registrationNo" TEXT NOT NULL DEFAULT '',
    "reference" TEXT NOT NULL DEFAULT '',
    "noPortal" BOOLEAN NOT NULL DEFAULT false,
    "portalUsername" TEXT NOT NULL DEFAULT '',
    "portalPasswordEnc" TEXT NOT NULL DEFAULT '',
    "pinCodeEnc" TEXT,
    "assignedToId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpFieldDef" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'TEXT',
    "allCountries" BOOLEAN NOT NULL DEFAULT false,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpFieldDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpFieldValue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpObligation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "portalUrl" TEXT NOT NULL DEFAULT '',
    "frequency" TEXT NOT NULL DEFAULT 'YEARLY',
    "yearsTotal" INTEGER,
    "basePeriodStart" DATE NOT NULL,
    "basePeriodEnd" DATE NOT NULL,
    "baseDueDate" DATE NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "assignedToId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "archivedBy" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpOccurrence" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "periodEndAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "datesConfirmed" BOOLEAN NOT NULL DEFAULT true,
    "overridden" BOOLEAN NOT NULL DEFAULT false,
    "stage" "CmpStage" NOT NULL DEFAULT 'OPEN',
    "closeKind" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "overdueNotedAt" TIMESTAMP(3),
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpReminder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "obligationId" TEXT NOT NULL,
    "offsetDays" INTEGER NOT NULL,
    "templateId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CmpReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'REMINDER',
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpMessage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "reminderId" TEXT,
    "templateId" TEXT,
    "invoiceId" TEXT,
    "receiptId" TEXT,
    "kind" TEXT NOT NULL,
    "templateName" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL,
    "fromPhone" TEXT NOT NULL DEFAULT '',
    "fromLabel" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL,
    "userId" TEXT,
    "userEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,

    CONSTRAINT "CmpMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpTaxRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(7,3) NOT NULL,
    "allCountries" BOOLEAN NOT NULL DEFAULT false,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpTaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "seqNo" INTEGER,
    "number" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL,
    "issueDate" DATE,
    "dueDate" DATE,
    "subtotal" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "received" DECIMAL(14,3) NOT NULL DEFAULT 0,
    "notes" TEXT NOT NULL DEFAULT '',
    "issuedAt" TIMESTAMP(3),
    "issuedBy" TEXT,
    "sentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CmpInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CmpInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpInvoiceTax" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(7,3) NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CmpInvoiceTax_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CmpReceipt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "seqNo" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "amount" DECIMAL(14,3) NOT NULL,
    "receivedOn" DATE NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'BANK',
    "reference" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "CmpReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CmpClient_tenantId_country_idx" ON "CmpClient"("tenantId", "country");

-- CreateIndex
CREATE INDEX "CmpClient_tenantId_name_idx" ON "CmpClient"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CmpClient_tenantId_code_key" ON "CmpClient"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "CmpFieldDef_tenantId_key_key" ON "CmpFieldDef"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CmpFieldValue_tenantId_fieldId_idx" ON "CmpFieldValue"("tenantId", "fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpFieldValue_clientId_fieldId_key" ON "CmpFieldValue"("clientId", "fieldId");

-- CreateIndex
CREATE INDEX "CmpObligation_tenantId_clientId_idx" ON "CmpObligation"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "CmpObligation_tenantId_name_idx" ON "CmpObligation"("tenantId", "name");

-- CreateIndex
CREATE INDEX "CmpOccurrence_tenantId_stage_dueAt_idx" ON "CmpOccurrence"("tenantId", "stage", "dueAt");

-- CreateIndex
CREATE INDEX "CmpOccurrence_tenantId_dueDate_idx" ON "CmpOccurrence"("tenantId", "dueDate");

-- CreateIndex
CREATE INDEX "CmpOccurrence_clientId_idx" ON "CmpOccurrence"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpOccurrence_obligationId_seq_key" ON "CmpOccurrence"("obligationId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "CmpReminder_obligationId_offsetDays_key" ON "CmpReminder"("obligationId", "offsetDays");

-- CreateIndex
CREATE UNIQUE INDEX "CmpTemplate_tenantId_name_key" ON "CmpTemplate"("tenantId", "name");

-- CreateIndex
CREATE INDEX "CmpMessage_tenantId_createdAt_idx" ON "CmpMessage"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "CmpMessage_clientId_createdAt_idx" ON "CmpMessage"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "CmpMessage_occurrenceId_reminderId_idx" ON "CmpMessage"("occurrenceId", "reminderId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpTaxRate_tenantId_name_rate_key" ON "CmpTaxRate"("tenantId", "name", "rate");

-- CreateIndex
CREATE INDEX "CmpInvoice_tenantId_status_idx" ON "CmpInvoice"("tenantId", "status");

-- CreateIndex
CREATE INDEX "CmpInvoice_clientId_idx" ON "CmpInvoice"("clientId");

-- CreateIndex
CREATE INDEX "CmpInvoice_occurrenceId_idx" ON "CmpInvoice"("occurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpInvoice_tenantId_number_key" ON "CmpInvoice"("tenantId", "number");

-- CreateIndex
CREATE INDEX "CmpReceipt_invoiceId_idx" ON "CmpReceipt"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "CmpReceipt_tenantId_number_key" ON "CmpReceipt"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "CmpSettings" ADD CONSTRAINT "CmpSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpClient" ADD CONSTRAINT "CmpClient_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpFieldDef" ADD CONSTRAINT "CmpFieldDef_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpFieldValue" ADD CONSTRAINT "CmpFieldValue_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "CmpClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpFieldValue" ADD CONSTRAINT "CmpFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CmpFieldDef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpObligation" ADD CONSTRAINT "CmpObligation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "CmpClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpOccurrence" ADD CONSTRAINT "CmpOccurrence_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "CmpObligation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpReminder" ADD CONSTRAINT "CmpReminder_obligationId_fkey" FOREIGN KEY ("obligationId") REFERENCES "CmpObligation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpReminder" ADD CONSTRAINT "CmpReminder_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CmpTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpTemplate" ADD CONSTRAINT "CmpTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "CmpClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "CmpOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_reminderId_fkey" FOREIGN KEY ("reminderId") REFERENCES "CmpReminder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "CmpTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CmpInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpMessage" ADD CONSTRAINT "CmpMessage_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "CmpReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpTaxRate" ADD CONSTRAINT "CmpTaxRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpInvoice" ADD CONSTRAINT "CmpInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpInvoice" ADD CONSTRAINT "CmpInvoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "CmpClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpInvoice" ADD CONSTRAINT "CmpInvoice_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "CmpOccurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpInvoiceLine" ADD CONSTRAINT "CmpInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CmpInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpInvoiceTax" ADD CONSTRAINT "CmpInvoiceTax_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CmpInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CmpReceipt" ADD CONSTRAINT "CmpReceipt_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "CmpInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
