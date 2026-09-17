-- CreateTable
CREATE TABLE "ClassroomAnnotation" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "resourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassroomAnnotation_sessionId_userId_resourceId_key" ON "ClassroomAnnotation"("sessionId", "userId", "resourceId");
CREATE INDEX "ClassroomAnnotation_sessionId_resourceId_idx" ON "ClassroomAnnotation"("sessionId", "resourceId");
CREATE INDEX "ClassroomAnnotation_userId_updatedAt_idx" ON "ClassroomAnnotation"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "ClassroomAnnotation" ADD CONSTRAINT "ClassroomAnnotation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClassroomAnnotation" ADD CONSTRAINT "ClassroomAnnotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
