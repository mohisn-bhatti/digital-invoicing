-- Which products a client may use (a user with more than one picks at login). Every existing client keeps Digital Invoicing.
ALTER TABLE "Tenant" ADD COLUMN "modules" TEXT[] DEFAULT ARRAY['INVOICING']::TEXT[];
