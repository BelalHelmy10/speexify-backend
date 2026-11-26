ALTER TABLE "FreeSessionRequest" ADD COLUMN "userId" INTEGER;

CREATE UNIQUE INDEX "FreeSessionRequest_userId_key" ON "FreeSessionRequest"("userId");

ALTER TABLE "FreeSessionRequest"
ADD CONSTRAINT "FreeSessionRequest_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
