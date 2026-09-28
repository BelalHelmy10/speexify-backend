ALTER TABLE "ClassroomMessage"
ADD COLUMN "recipientId" INTEGER,
ADD COLUMN "visibility" TEXT NOT NULL DEFAULT 'public';

ALTER TABLE "ClassroomMessage"
ADD CONSTRAINT "ClassroomMessage_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ClassroomMessage_sessionId_visibility_createdAt_idx"
ON "ClassroomMessage"("sessionId", "visibility", "createdAt");

CREATE INDEX "ClassroomMessage_recipientId_createdAt_idx"
ON "ClassroomMessage"("recipientId", "createdAt");
