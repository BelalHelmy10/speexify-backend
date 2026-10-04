ALTER TYPE "SessionType" ADD VALUE IF NOT EXISTS 'TRAINING';
ALTER TABLE "Session" ADD COLUMN "trainingAdminId" INTEGER;
ALTER TABLE "Session" ADD CONSTRAINT "Session_trainingAdminId_fkey" FOREIGN KEY ("trainingAdminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Session_trainingAdminId_startAt_idx" ON "Session"("trainingAdminId", "startAt");
