-- FBR DI API v1.12: sales tax is checked against rate × value (error 0104) and excludes extra tax, and further tax has
-- its own rule — so an item's "more taxes" can only go to FBR's Extra Tax or FED Payable box. Existing ones that
-- pointed at Sales Tax / Further Tax move to Extra Tax (the tax rule history keeps what was set at the time).
UPDATE "Product" p SET "extraTaxes" = (
  SELECT jsonb_agg(CASE WHEN e->>'fbrField' IN ('salesTaxApplicable', 'furtherTax') THEN jsonb_set(e, '{fbrField}', '"extraTax"') ELSE e END ORDER BY i)
  FROM jsonb_array_elements(p."extraTaxes") WITH ORDINALITY AS t(e, i)
)
WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(p."extraTaxes") e WHERE e->>'fbrField' IN ('salesTaxApplicable', 'furtherTax'));
