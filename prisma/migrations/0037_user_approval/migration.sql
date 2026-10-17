-- Users added by a client owner wait for the administrator's approval before they can log in
ALTER TABLE "User" ADD COLUMN "pendingApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "requestedBy" TEXT;
