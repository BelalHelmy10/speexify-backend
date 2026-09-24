CREATE TABLE "CalendarFeedToken" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CalendarFeedToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CalendarFeedToken_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "CalendarFeedToken_tokenHash_key"
  ON "CalendarFeedToken"("tokenHash");
CREATE INDEX "CalendarFeedToken_userId_revokedAt_idx"
  ON "CalendarFeedToken"("userId", "revokedAt");
CREATE INDEX "CalendarFeedToken_expiresAt_idx"
  ON "CalendarFeedToken"("expiresAt");
