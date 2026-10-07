-- CreateTable
CREATE TABLE "HsTaxRule" (
    "id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "saleType" TEXT NOT NULL,
    "rate" TEXT NOT NULL DEFAULT '',
    "sroScheduleNo" TEXT NOT NULL DEFAULT '',
    "sroItemSerialNo" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "updatedBy" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HsTaxRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceDraft" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "data" JSONB NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HsTaxRule_prefix_key" ON "HsTaxRule"("prefix");

-- CreateIndex
CREATE INDEX "InvoiceDraft_tenantId_updatedAt_idx" ON "InvoiceDraft"("tenantId", "updatedAt");

-- AddForeignKey
ALTER TABLE "InvoiceDraft" ADD CONSTRAINT "InvoiceDraft_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Starting rules from the CA's "Document 1" (Sales Tax Act schedules). Codes not listed default to standard rate 18%.
-- The admin edits these under Tax Rules; they are suggestions on the invoice form, never forced.
INSERT INTO "HsTaxRule" ("id", "prefix", "saleType", "rate", "sroScheduleNo", "sroItemSerialNo", "note", "updatedAt") VALUES
-- Third Schedule: 18% on the printed retail price; no further tax (SRO 648(I)/2013)
(gen_random_uuid()::text, '0902', '3rd Schedule Goods', '18%', '', '', 'Tea — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '1704', '3rd Schedule Goods', '18%', '', '', 'Sugar confectionery — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '1806', '3rd Schedule Goods', '18%', '', '', 'Chocolate — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '2009', '3rd Schedule Goods', '18%', '', '', 'Fruit juices — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '2105', '3rd Schedule Goods', '18%', '', '', 'Ice cream — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '2201', '3rd Schedule Goods', '18%', '', '', 'Waters — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '2202', '3rd Schedule Goods', '18%', '', '', 'Aerated / flavoured waters — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '2402', '3rd Schedule Goods', '18%', '', '', 'Cigarettes — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3208', '3rd Schedule Goods', '18%', '', '', 'Paints / varnishes — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3209', '3rd Schedule Goods', '18%', '', '', 'Paints / varnishes — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3210', '3rd Schedule Goods', '18%', '', '', 'Paints / varnishes — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3303', '3rd Schedule Goods', '18%', '', '', 'Perfumes — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3304', '3rd Schedule Goods', '18%', '', '', 'Cosmetics — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3305', '3rd Schedule Goods', '18%', '', '', 'Shampoo / hair preparations — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3306', '3rd Schedule Goods', '18%', '', '', 'Toothpaste — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3401', '3rd Schedule Goods', '18%', '', '', 'Soap — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '3402', '3rd Schedule Goods', '18%', '', '', 'Detergents — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '4818', '3rd Schedule Goods', '18%', '', '', 'Tissues — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '6401', '3rd Schedule Goods', '18%', '', '', 'Footwear — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '6402', '3rd Schedule Goods', '18%', '', '', 'Footwear — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '6403', '3rd Schedule Goods', '18%', '', '', 'Footwear — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '6404', '3rd Schedule Goods', '18%', '', '', 'Footwear — Third Schedule: tax on printed retail price', now()),
(gen_random_uuid()::text, '6405', '3rd Schedule Goods', '18%', '', '', 'Footwear — Third Schedule: tax on printed retail price', now()),
-- Sixth Schedule: exempt (Section 13); the item serial no. of the schedule must be entered
(gen_random_uuid()::text, '01', 'Exempt Goods', 'Exempt', '6th Schedule Table II', '', 'Live animals — exempt on local supply; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '0401', 'Exempt Goods', 'Exempt', '6th Schedule Table II', '', 'Fresh milk — exempt only if not packaged/branded; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '0713', 'Exempt Goods', 'Exempt', '6th Schedule Table I', '', 'Pulses — exempt; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '1001', 'Exempt Goods', 'Exempt', '6th Schedule Table I', '', 'Wheat — exempt; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '1006', 'Exempt Goods', 'Exempt', '6th Schedule Table I', '', 'Rice — exempt; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '48202000', 'Exempt Goods', 'Exempt', '6th Schedule Table I', '', 'Exercise books — exempt; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '4901', 'Exempt Goods', 'Exempt', '6th Schedule Table I', '', 'Printed books / textbooks — exempt; enter the schedule serial no.', now()),
(gen_random_uuid()::text, '8713', 'Exempt Goods', 'Exempt', '6th Schedule Table I', '', 'Wheelchairs — exempt; enter the schedule serial no.', now()),
-- Fifth Schedule: zero-rated
(gen_random_uuid()::text, '2709', 'Goods at zero-rate', '0%', '5th Schedule', '20', 'Crude petroleum oil — zero-rated (Fifth Schedule S. No. 20)', now()),
-- Eighth Schedule Table 1: reduced rates; further tax 4% still applies to unregistered buyers
(gen_random_uuid()::text, '84713010', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '77', 'Laptop computers — 10% (Eighth Schedule S. No. 77)', now()),
(gen_random_uuid()::text, '84713020', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '77', 'Personal computers — 10% (Eighth Schedule S. No. 77)', now()),
(gen_random_uuid()::text, '85414200', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '90', 'Solar panels / PV cells — 10% (Eighth Schedule S. No. 90)', now()),
(gen_random_uuid()::text, '85414300', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '90', 'Solar panels / PV cells — 10% (Eighth Schedule S. No. 90)', now()),
(gen_random_uuid()::text, '23061000', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '85', 'Cotton seed oilcake / meal — 10% (Eighth Schedule S. No. 85)', now()),
(gen_random_uuid()::text, '2306', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '88', 'Animal feed (oilcake) — 10% (Eighth Schedule S. No. 88)', now()),
(gen_random_uuid()::text, '2309', 'Goods at Reduced Rate', '10%', '8th Schedule Table 1', '88', 'Poultry and animal feed — 10% (Eighth Schedule S. No. 88)', now()),
(gen_random_uuid()::text, '23091000', 'Goods at standard rate (default)', '18%', '', '', 'Dog / cat food for retail sale — standard rate', now()),
(gen_random_uuid()::text, '6309', 'Goods at Reduced Rate', '5%', '8th Schedule Table 1', '23', 'Second-hand clothing / footwear — 5% (Eighth Schedule S. No. 23)', now()),
(gen_random_uuid()::text, '7113', 'Goods at Reduced Rate', '1%', '8th Schedule Table 1', '78', 'Jewellery — 1% only if locally manufactured (Eighth Schedule S. No. 78)', now()),
(gen_random_uuid()::text, '87019220', 'Goods at Reduced Rate', '14%', '8th Schedule Table 1', '86', 'Agricultural tractors — 14% (Eighth Schedule S. No. 86, SRO 1635(I)/2024)', now()),
(gen_random_uuid()::text, '87019320', 'Goods at Reduced Rate', '14%', '8th Schedule Table 1', '86', 'Agricultural tractors — 14% (Eighth Schedule S. No. 86, SRO 1635(I)/2024)', now()),
-- Special regimes: the sale type is known, the rate depends on the notification
(gen_random_uuid()::text, '851712', 'Mobile Phones', '', '', '', 'Mobile phones — Ninth Schedule: fixed tax by value slab; check the rate', now()),
(gen_random_uuid()::text, '851713', 'Mobile Phones', '', '', '', 'Mobile phones — Ninth Schedule: fixed tax by value slab; check the rate', now()),
(gen_random_uuid()::text, '7206', 'Steel Melting and re-rolling', '18%', '', '', 'Steel ingots — Thirteenth Schedule / SRO 1636(I)/2024 minimum values', now()),
(gen_random_uuid()::text, '7207', 'Steel Melting and re-rolling', '18%', '', '', 'Steel billets — Thirteenth Schedule / SRO 1636(I)/2024 minimum values', now()),
(gen_random_uuid()::text, '7214', 'Steel Melting and re-rolling', '18%', '', '', 'Steel bars — Thirteenth Schedule / SRO 1636(I)/2024 minimum values', now()),
(gen_random_uuid()::text, '2710', 'Petroleum Products', '', '', '', 'Petroleum products — rate notified per product (Section 3(2)(b)); check the rate', now());
