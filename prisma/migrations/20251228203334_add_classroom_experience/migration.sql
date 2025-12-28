-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "resourcesUsed" JSONB DEFAULT '[]',
ADD COLUMN     "resourcesUsedAt" JSONB DEFAULT '{}',
ADD COLUMN     "teacherNotes" TEXT;

-- CreateTable
CREATE TABLE "LearnerSessionFeedback" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "learnerId" INTEGER NOT NULL,
    "rating" INTEGER NOT NULL,
    "highlights" TEXT,
    "improvements" TEXT,
    "otherFeedback" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnerSessionFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LearnerSessionFeedback_sessionId_idx" ON "LearnerSessionFeedback"("sessionId");

-- CreateIndex
CREATE INDEX "LearnerSessionFeedback_learnerId_idx" ON "LearnerSessionFeedback"("learnerId");

-- CreateIndex
CREATE UNIQUE INDEX "LearnerSessionFeedback_sessionId_learnerId_key" ON "LearnerSessionFeedback"("sessionId", "learnerId");

-- AddForeignKey
ALTER TABLE "LearnerSessionFeedback" ADD CONSTRAINT "LearnerSessionFeedback_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnerSessionFeedback" ADD CONSTRAINT "LearnerSessionFeedback_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
