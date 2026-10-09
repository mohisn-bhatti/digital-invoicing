-- The app is now called ETAX: saved tax-rule notes that named the old app are renamed
UPDATE "HsTaxRule" SET "source" = replace("source", 'Raseed', 'ETAX'), "note" = replace("note", 'Raseed', 'ETAX')
WHERE "source" LIKE '%Raseed%' OR "note" LIKE '%Raseed%';
