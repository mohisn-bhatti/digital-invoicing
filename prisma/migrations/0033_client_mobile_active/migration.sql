-- Client contact mobile (admin or the client's owner adds it) and active / inactive (inactive: its users can't log in)
ALTER TABLE "Tenant" ADD COLUMN "mobile" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Tenant" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;
