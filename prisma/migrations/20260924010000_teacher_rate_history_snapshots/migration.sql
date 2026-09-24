-- Preserve the instant at which a session became completed. Existing rows use
-- updatedAt as the safest available historical approximation.
ALTER TABLE "Session" ADD COLUMN "completedAt" TIMESTAMP(3);

UPDATE "Session"
SET "completedAt" = "updatedAt"
WHERE "status" = 'completed' AND "completedAt" IS NULL;

-- Make the completion-time rate snapshot explicit for every earning row.
ALTER TABLE "TeacherEarning"
  ADD COLUMN "rateSnapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "rateEffectiveFrom" TIMESTAMP(3),
  ADD COLUMN "rateSnapshotSource" TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE "TeacherRateHistory" (
  "id" SERIAL NOT NULL,
  "teacherId" INTEGER NOT NULL,
  "effectiveFrom" TIMESTAMP(3) NOT NULL,
  "effectiveTo" TIMESTAMP(3),
  "rateHourlyEgpPiastres" INTEGER,
  "ratePerSessionEgpPiastres" INTEGER,
  "createdById" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TeacherRateHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherRateHistory_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherRateHistory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TeacherRateHistory_teacherId_effectiveFrom_key"
  ON "TeacherRateHistory"("teacherId", "effectiveFrom");
CREATE INDEX "TeacherRateHistory_teacherId_effectiveFrom_idx"
  ON "TeacherRateHistory"("teacherId", "effectiveFrom");

CREATE TABLE "TeacherEarningSnapshotJob" (
  "id" SERIAL NOT NULL,
  "sessionId" INTEGER NOT NULL,
  "teacherId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "succeededAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TeacherEarningSnapshotJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherEarningSnapshotJob_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherEarningSnapshotJob_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TeacherEarningSnapshotJob_sessionId_key"
  ON "TeacherEarningSnapshotJob"("sessionId");
CREATE INDEX "TeacherEarningSnapshotJob_status_nextAttemptAt_idx"
  ON "TeacherEarningSnapshotJob"("status", "nextAttemptAt");
CREATE INDEX "TeacherEarningSnapshotJob_status_lockedAt_idx"
  ON "TeacherEarningSnapshotJob"("status", "lockedAt");
CREATE INDEX "TeacherEarningSnapshotJob_teacherId_status_idx"
  ON "TeacherEarningSnapshotJob"("teacherId", "status");
