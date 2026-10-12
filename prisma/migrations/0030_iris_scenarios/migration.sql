-- What IRIS shows for this client's sandbox scenarios, recorded by the admin: { assigned: [...], passed: [...], at, by }.
-- IRIS is the official record; scenarios filed through ETAX are still counted on their own.
ALTER TABLE "Tenant" ADD COLUMN "irisScenarios" JSONB;
