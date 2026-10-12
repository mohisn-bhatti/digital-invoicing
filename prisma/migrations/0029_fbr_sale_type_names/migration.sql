-- Sale type names as FBR's live list (transtypecode) spells them; FBR's sandbox refused "Processing/ Conversion of Goods"
-- (error 0204). Items and the tax rules data bank only — filed invoices and tax rule history keep what was sent.
UPDATE "Product" SET "saleType" = CASE "saleType"
    WHEN 'Exempt Goods' THEN 'Exempt goods'
    WHEN 'Processing/ Conversion of Goods' THEN 'Processing/Conversion of Goods'
    WHEN 'Steel Melting and re-rolling' THEN 'Steel melting and re-rolling'
    WHEN 'Cotton Ginners' THEN 'Cotton ginners'
    ELSE "saleType" END
WHERE "saleType" IN ('Exempt Goods', 'Processing/ Conversion of Goods', 'Steel Melting and re-rolling', 'Cotton Ginners');

UPDATE "HsTaxRule" SET "saleType" = CASE "saleType"
    WHEN 'Exempt Goods' THEN 'Exempt goods'
    WHEN 'Processing/ Conversion of Goods' THEN 'Processing/Conversion of Goods'
    WHEN 'Steel Melting and re-rolling' THEN 'Steel melting and re-rolling'
    WHEN 'Cotton Ginners' THEN 'Cotton ginners'
    ELSE "saleType" END
WHERE "saleType" IN ('Exempt Goods', 'Processing/ Conversion of Goods', 'Steel Melting and re-rolling', 'Cotton Ginners');
