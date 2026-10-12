-- Seller NTN and CNIC kept in separate boxes; "sellerNtnCnic" stays the one number sent to FBR (NTN, else CNIC)
ALTER TABLE "Tenant" ADD COLUMN "sellerNtn" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Tenant" ADD COLUMN "sellerCnic" TEXT NOT NULL DEFAULT '';
UPDATE "Tenant" SET "sellerCnic" = "sellerNtnCnic" WHERE length("sellerNtnCnic") = 13;
UPDATE "Tenant" SET "sellerNtn" = "sellerNtnCnic" WHERE length("sellerNtnCnic") IN (7, 9);
