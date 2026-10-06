-- CreateTable
CREATE TABLE "HsCode" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'PCT-2017',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HsCode_pkey" PRIMARY KEY ("code")
);

