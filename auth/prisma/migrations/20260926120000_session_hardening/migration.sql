-- Emails are now stored lower-case so "A@x.com" and "a@x.com" are one account.
UPDATE "User" SET "email" = LOWER(TRIM("email"));

-- Refresh-token families for reuse detection.
ALTER TABLE "Session" ADD COLUMN "familyId" TEXT;
UPDATE "Session" SET "familyId" = "id";
ALTER TABLE "Session" ALTER COLUMN "familyId" SET NOT NULL;
ALTER TABLE "Session" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshTokenHash_key" ON "Session"("refreshTokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_familyId_idx" ON "Session"("familyId");

-- Deleting a user now deletes their sessions.
ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
