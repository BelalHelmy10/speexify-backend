CREATE TABLE "ClassroomMaterial" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "uploadedBy" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomMaterial_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClassroomMaterial_sessionId_createdAt_idx" ON "ClassroomMaterial"("sessionId", "createdAt");

ALTER TABLE "ClassroomMaterial" ADD CONSTRAINT "ClassroomMaterial_sessionId_fkey"
FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
