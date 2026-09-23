CREATE TABLE "TeacherPayout" (
  "id" SERIAL PRIMARY KEY,
  "teacherId" INTEGER NOT NULL,
  "createdById" INTEGER NOT NULL,
  "totalMinor" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'EGP',
  "paymentMethod" TEXT NOT NULL,
  "paymentReference" TEXT,
  "note" TEXT,
  "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeacherPayout_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherPayout_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- Do not copy the legacy rate fields: their historical currency is ambiguous.
-- Admins must explicitly confirm/set each teacher's EGP rate before payout.
ALTER TABLE "User"
  ADD COLUMN "rateHourlyEgpPiastres" INTEGER,
  ADD COLUMN "ratePerSessionEgpPiastres" INTEGER;

CREATE TABLE "TeacherEarning" (
  "id" SERIAL PRIMARY KEY,
  "teacherId" INTEGER NOT NULL,
  "sessionId" INTEGER NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'EGP',
  "rateType" TEXT NOT NULL DEFAULT 'none',
  "rateMinor" INTEGER,
  "durationMinutes" INTEGER NOT NULL DEFAULT 60,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "paidAt" TIMESTAMP(3),
  "payoutId" INTEGER,
  CONSTRAINT "TeacherEarning_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherEarning_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherEarning_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "TeacherPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TeacherEarning_sessionId_key" ON "TeacherEarning"("sessionId");
CREATE INDEX "TeacherEarning_teacherId_status_createdAt_idx" ON "TeacherEarning"("teacherId", "status", "createdAt");
CREATE INDEX "TeacherEarning_payoutId_idx" ON "TeacherEarning"("payoutId");
CREATE INDEX "TeacherPayout_teacherId_paidAt_idx" ON "TeacherPayout"("teacherId", "paidAt");
