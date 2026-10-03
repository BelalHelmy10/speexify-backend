CREATE TABLE "ClassRecording" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER,
    "sessionTitle" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassRecording_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassRecording_objectKey_key" ON "ClassRecording"("objectKey");
CREATE INDEX "ClassRecording_sessionId_createdAt_idx" ON "ClassRecording"("sessionId", "createdAt");
CREATE INDEX "ClassRecording_createdAt_idx" ON "ClassRecording"("createdAt");

ALTER TABLE "ClassRecording" ADD CONSTRAINT "ClassRecording_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
