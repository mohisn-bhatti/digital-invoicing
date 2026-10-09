-- Buyer contact details (CA): mobile number, email and an additional note
-- AlterTable
ALTER TABLE "Buyer" ADD COLUMN     "mobile" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "email" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "note" TEXT NOT NULL DEFAULT '';
