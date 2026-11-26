-- CreateEnum
CREATE TYPE "HomeworkStatus" AS ENUM ('ASSIGNED', 'IN_PROGRESS', 'SUBMITTED', 'REVIEWED');

-- CreateTable
CREATE TABLE "HomeworkAssignment" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER,
    "learnerId" INTEGER NOT NULL,
    "teacherId" INTEGER,
    "templateId" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "level" TEXT,
    "content" JSONB NOT NULL,
    "note" TEXT,
    "dueAt" TIMESTAMP(3),
    "status" "HomeworkStatus" NOT NULL DEFAULT 'ASSIGNED',
    "answers" JSONB NOT NULL DEFAULT '{}',
    "answersVersion" INTEGER NOT NULL DEFAULT 0,
    "completedTasks" INTEGER NOT NULL DEFAULT 0,
    "taskCount" INTEGER NOT NULL,
    "lastActivityAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "autoScore" JSONB,
    "teacherComments" JSONB NOT NULL DEFAULT '{}',
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeworkAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HomeworkAssignment_learnerId_status_dueAt_idx" ON "HomeworkAssignment"("learnerId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "HomeworkAssignment_teacherId_status_dueAt_idx" ON "HomeworkAssignment"("teacherId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "HomeworkAssignment_sessionId_idx" ON "HomeworkAssignment"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeworkAssignment_sessionId_learnerId_templateId_key" ON "HomeworkAssignment"("sessionId", "learnerId", "templateId");

-- AddForeignKey
ALTER TABLE "HomeworkAssignment" ADD CONSTRAINT "HomeworkAssignment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkAssignment" ADD CONSTRAINT "HomeworkAssignment_learnerId_fkey" FOREIGN KEY ("learnerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeworkAssignment" ADD CONSTRAINT "HomeworkAssignment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

