-- CreateTable
CREATE TABLE "GuideLink" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuideLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL DEFAULT 'system',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- Starting guideline buttons (Sales Tax Act amended up to 30-06-2026; #page= jumps to each schedule)
INSERT INTO "GuideLink" ("id", "label", "url", "sortOrder", "updatedAt") VALUES
(gen_random_uuid()::text, 'Sales Tax Act (30-06-2026) PDF', 'https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf', 10, now()),
(gen_random_uuid()::text, '3rd Schedule — retail price', 'https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf#page=143', 20, now()),
(gen_random_uuid()::text, '5th Schedule — zero-rated', 'https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf#page=149', 30, now()),
(gen_random_uuid()::text, '6th Schedule — exempt', 'https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf#page=153', 40, now()),
(gen_random_uuid()::text, '8th Schedule — reduced rates', 'https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf#page=205', 50, now()),
(gen_random_uuid()::text, '9th Schedule — mobile phones', 'https://download1.fbr.gov.pk/Docs/20267171373418951SalesTaxAct1990updatedupto30.06.2026.pdf#page=215', 60, now()),
(gen_random_uuid()::text, 'Sales tax SROs', 'https://www.fbr.gov.pk/ShowSROs?Department=Sales%20Tax', 70, now()),
(gen_random_uuid()::text, 'Circulars', 'https://www.fbr.gov.pk/Orders/Sales-Tax-Circulars/180', 80, now()),
(gen_random_uuid()::text, 'General orders', 'https://www.fbr.gov.pk/Orders/Sales-Tax-General-Orders/151', 90, now()),
(gen_random_uuid()::text, 'FBR notice board', 'https://www.fbr.gov.pk/categ/admin-notice-board/444', 100, now()),
(gen_random_uuid()::text, 'HS codes (Customs Tariff)', 'https://download1.fbr.gov.pk/Docs/2017112112112348253CustomsTariff2017-18Ch1-99.pdf', 110, now());

INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES
('guidelinesNote', 'Standard rate is 18% (section 3(1)). Further tax 4% for unregistered buyers is added on the invoice automatically. Exempt and reduced-rate items need the schedule / SRO and its serial number, e.g. "6th Schd Table I" and "19".', now());
