-- Explicit payout status and append-only void/reversal records.
ALTER TABLE "TeacherPayout"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PAID';

ALTER TABLE "TeacherPayout"
  ADD CONSTRAINT "TeacherPayout_status_check"
    CHECK ("status" IN ('PAID', 'VOIDED', 'REVERSED'));

CREATE TABLE "TeacherPayoutReversal" (
  "id" SERIAL NOT NULL,
  "payoutId" INTEGER NOT NULL,
  "teacherId" INTEGER NOT NULL,
  "createdById" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "amountMinor" INTEGER NOT NULL,
  "currencyCode" TEXT NOT NULL DEFAULT 'EGP',
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TeacherPayoutReversal_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherPayoutReversal_payoutId_key" UNIQUE ("payoutId"),
  CONSTRAINT "TeacherPayoutReversal_payoutId_fkey"
    FOREIGN KEY ("payoutId") REFERENCES "TeacherPayout"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherPayoutReversal_teacherId_fkey"
    FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherPayoutReversal_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TeacherPayoutReversal_action_check"
    CHECK ("action" IN ('VOID', 'REVERSE')),
  CONSTRAINT "TeacherPayoutReversal_currencyCode_check"
    CHECK ("currencyCode" = 'EGP'),
  CONSTRAINT "TeacherPayoutReversal_amountMinor_check"
    CHECK ("amountMinor" > 0)
);

CREATE INDEX "TeacherPayout_teacherId_status_paidAt_idx"
  ON "TeacherPayout"("teacherId", "status", "paidAt");
CREATE INDEX "TeacherPayoutReversal_teacherId_createdAt_idx"
  ON "TeacherPayoutReversal"("teacherId", "createdAt");
CREATE INDEX "TeacherPayoutReversal_action_createdAt_idx"
  ON "TeacherPayoutReversal"("action", "createdAt");
