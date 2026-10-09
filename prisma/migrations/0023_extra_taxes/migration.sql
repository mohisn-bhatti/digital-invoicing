-- "More taxes" on an item's tax rule (CA): name, % or fixed Rs, applied on value / value after tax / sales tax /
-- an earlier extra tax, and the FBR box it goes in. Invoice lines keep the definitions and the computed amounts.
-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "extraTaxes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "ProductTaxRule" ADD COLUMN     "extraTaxes" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "InvoiceItem" ADD COLUMN     "extraTaxes" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "extraTaxDetail" JSONB NOT NULL DEFAULT '[]';
