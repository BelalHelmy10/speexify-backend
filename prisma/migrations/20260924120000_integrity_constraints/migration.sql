-- Data-integrity constraints for the payroll and credit ledgers.
-- These checks deliberately fail the migration when legacy data is outside
-- the supported state space instead of silently rewriting financial history.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "TeacherEarning" WHERE "currencyCode" <> 'EGP')
    OR EXISTS (SELECT 1 FROM "TeacherEarningAdjustment" WHERE "currencyCode" <> 'EGP')
    OR EXISTS (SELECT 1 FROM "TeacherPayout" WHERE "currencyCode" <> 'EGP') THEN
    RAISE EXCEPTION 'Cannot constrain payroll currency: non-EGP historical rows exist';
  END IF;

  IF EXISTS (SELECT 1 FROM "TeacherEarning" WHERE "status" NOT IN ('PENDING', 'PAID'))
    OR EXISTS (SELECT 1 FROM "TeacherEarningAdjustment" WHERE "status" NOT IN ('PENDING', 'PAID')) THEN
    RAISE EXCEPTION 'Cannot constrain payroll status: unsupported historical rows exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "TeacherEarningSnapshotJob"
    WHERE "status" NOT IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')
  ) THEN
    RAISE EXCEPTION 'Cannot constrain snapshot-job status: unsupported historical rows exist';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "TeacherPayout"
    WHERE "paymentMethod" NOT IN ('bank_transfer', 'cash', 'wallet', 'other')
  ) THEN
    RAISE EXCEPTION 'Cannot constrain payout method: unsupported historical rows exist';
  END IF;

  IF EXISTS (SELECT 1 FROM "TeacherPayout" WHERE "paidAt" > "createdAt") THEN
    RAISE EXCEPTION 'Cannot constrain payout dates: future-dated historical rows exist';
  END IF;
END $$;

ALTER TABLE "TeacherEarning"
  ADD CONSTRAINT "TeacherEarning_currencyCode_check"
    CHECK ("currencyCode" = 'EGP'),
  ADD CONSTRAINT "TeacherEarning_status_check"
    CHECK ("status" IN ('PENDING', 'PAID')),
  ADD CONSTRAINT "TeacherEarning_rateType_check"
    CHECK ("rateType" IN ('none', 'hourly', 'per_session')),
  ADD CONSTRAINT "TeacherEarning_amountMinor_check"
    CHECK ("amountMinor" >= 0);

ALTER TABLE "TeacherEarningAdjustment"
  ADD CONSTRAINT "TeacherEarningAdjustment_currencyCode_check"
    CHECK ("currencyCode" = 'EGP'),
  ADD CONSTRAINT "TeacherEarningAdjustment_status_check"
    CHECK ("status" IN ('PENDING', 'PAID')),
  ADD CONSTRAINT "TeacherEarningAdjustment_amountMinor_check"
    CHECK ("amountMinor" <> 0);

ALTER TABLE "TeacherEarningSnapshotJob"
  ADD CONSTRAINT "TeacherEarningSnapshotJob_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  ADD CONSTRAINT "TeacherEarningSnapshotJob_attempts_check"
    CHECK ("attempts" >= 0);

ALTER TABLE "TeacherPayout"
  ADD CONSTRAINT "TeacherPayout_currencyCode_check"
    CHECK ("currencyCode" = 'EGP'),
  ADD CONSTRAINT "TeacherPayout_paymentMethod_check"
    CHECK ("paymentMethod" IN ('bank_transfer', 'cash', 'wallet', 'other')),
  ADD CONSTRAINT "TeacherPayout_totalMinor_check"
    CHECK ("totalMinor" > 0),
  ADD CONSTRAINT "TeacherPayout_paidAt_not_future_check"
    CHECK ("paidAt" <= "createdAt");

-- Keep the active-debit invariant explicit even on databases restored without
-- the original credit-debit migration's index.
CREATE UNIQUE INDEX IF NOT EXISTS "CreditDebit_active_booking_key"
  ON "CreditDebit"("sessionId", "userId")
  WHERE "reversedAt" IS NULL;
