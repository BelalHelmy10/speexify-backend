-- Step 16: Database integrity pass
-- Adds missing FK coverage, stronger constraints, and indexes for hot query paths.

-- ---------------------------------------------------------------------------
-- Normalize orphan references before adding FK constraints
-- ---------------------------------------------------------------------------
UPDATE "Order" o
SET "userId" = NULL
WHERE "userId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "User" u
    WHERE u."id" = o."userId"
  );

UPDATE "Order" o
SET "packageId" = NULL
WHERE "packageId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "Package" p
    WHERE p."id" = o."packageId"
  );

UPDATE "Session" s
SET "userId" = NULL
WHERE "userId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "User" u
    WHERE u."id" = s."userId"
  );

UPDATE "Session" s
SET "teacherId" = NULL
WHERE "teacherId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "User" u
    WHERE u."id" = s."teacherId"
  );

-- ---------------------------------------------------------------------------
-- FK hardening (Order -> User/Package)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Order_userId_fkey'
      AND conrelid = '"Order"'::regclass
  ) THEN
    ALTER TABLE "Order"
    ADD CONSTRAINT "Order_userId_fkey"
    FOREIGN KEY ("userId")
    REFERENCES "User"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Order_packageId_fkey'
      AND conrelid = '"Order"'::regclass
  ) THEN
    ALTER TABLE "Order"
    ADD CONSTRAINT "Order_packageId_fkey"
    FOREIGN KEY ("packageId")
    REFERENCES "Package"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- FK behavior alignment (Session optional users should not block user deletion)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Session_userId_fkey'
      AND conrelid = '"Session"'::regclass
  ) THEN
    ALTER TABLE "Session" DROP CONSTRAINT "Session_userId_fkey";
  END IF;

  ALTER TABLE "Session"
  ADD CONSTRAINT "Session_userId_fkey"
  FOREIGN KEY ("userId")
  REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Session_teacherId_fkey'
      AND conrelid = '"Session"'::regclass
  ) THEN
    ALTER TABLE "Session" DROP CONSTRAINT "Session_teacherId_fkey";
  END IF;

  ALTER TABLE "Session"
  ADD CONSTRAINT "Session_teacherId_fkey"
  FOREIGN KEY ("teacherId")
  REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
END
$$;

-- ---------------------------------------------------------------------------
-- Hot-path indexes (aligned with app query shapes)
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "Availability_user_status_recur_day_start_idx"
  ON "Availability"("userId", "status", "isRecurring", "dayOfWeek", "startTime");

CREATE INDEX IF NOT EXISTS "Availability_user_status_recur_date_start_idx"
  ON "Availability"("userId", "status", "isRecurring", "specificDate", "startTime");

CREATE INDEX IF NOT EXISTS "Notification_userId_readAt_id_idx"
  ON "Notification"("userId", "readAt", "id");

CREATE INDEX IF NOT EXISTS "SupportTicket_userId_status_updatedAt_idx"
  ON "SupportTicket"("userId", "status", "updatedAt");

CREATE INDEX IF NOT EXISTS "SupportTicket_status_priority_updatedAt_idx"
  ON "SupportTicket"("status", "priority", "updatedAt");

CREATE INDEX IF NOT EXISTS "Session_status_startAt_idx"
  ON "Session"("status", "startAt");

CREATE INDEX IF NOT EXISTS "Session_teacherId_status_startAt_idx"
  ON "Session"("teacherId", "status", "startAt");

CREATE INDEX IF NOT EXISTS "Session_userId_status_startAt_idx"
  ON "Session"("userId", "status", "startAt");

CREATE INDEX IF NOT EXISTS "SessionParticipant_userId_status_idx"
  ON "SessionParticipant"("userId", "status");

CREATE INDEX IF NOT EXISTS "SessionParticipant_sessionId_status_idx"
  ON "SessionParticipant"("sessionId", "status");

CREATE INDEX IF NOT EXISTS "Order_status_updatedAt_idx"
  ON "Order"("status", "updatedAt");

CREATE INDEX IF NOT EXISTS "Order_paymobTxnId_idx"
  ON "Order"("paymobTxnId");

CREATE INDEX IF NOT EXISTS "Order_pspOrderId_idx"
  ON "Order"("pspOrderId");

CREATE INDEX IF NOT EXISTS "UserPackage_userId_status_expiresAt_idx"
  ON "UserPackage"("userId", "status", "expiresAt");

CREATE INDEX IF NOT EXISTS "UserPackage_userId_status_createdAt_idx"
  ON "UserPackage"("userId", "status", "createdAt");

-- Reminder scheduler lookup acceleration (targeted partial indexes)
CREATE INDEX IF NOT EXISTS "Session_reminder24h_pending_idx"
  ON "Session"("startAt")
  WHERE "status" = 'scheduled' AND "reminder24hSentAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Session_reminder6h_pending_idx"
  ON "Session"("startAt")
  WHERE "status" = 'scheduled' AND "reminder6hSentAt" IS NULL;

CREATE INDEX IF NOT EXISTS "Session_reminder1h_pending_idx"
  ON "Session"("startAt")
  WHERE "status" = 'scheduled' AND "reminder1hSentAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Data integrity checks (NOT VALID to avoid blocking migration on legacy rows)
-- New/updated rows are enforced immediately.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Session_endAt_after_startAt_chk'
      AND conrelid = '"Session"'::regclass
  ) THEN
    ALTER TABLE "Session"
    ADD CONSTRAINT "Session_endAt_after_startAt_chk"
    CHECK ("endAt" IS NULL OR "endAt" > "startAt")
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Session_capacity_positive_chk'
      AND conrelid = '"Session"'::regclass
  ) THEN
    ALTER TABLE "Session"
    ADD CONSTRAINT "Session_capacity_positive_chk"
    CHECK ("capacity" IS NULL OR "capacity" > 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Session_feedbackScore_range_chk'
      AND conrelid = '"Session"'::regclass
  ) THEN
    ALTER TABLE "Session"
    ADD CONSTRAINT "Session_feedbackScore_range_chk"
    CHECK ("feedbackScore" IS NULL OR ("feedbackScore" >= 1 AND "feedbackScore" <= 5))
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'UserPackage_sessionsTotal_nonnegative_chk'
      AND conrelid = '"UserPackage"'::regclass
  ) THEN
    ALTER TABLE "UserPackage"
    ADD CONSTRAINT "UserPackage_sessionsTotal_nonnegative_chk"
    CHECK ("sessionsTotal" >= 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'UserPackage_sessionsUsed_bounds_chk'
      AND conrelid = '"UserPackage"'::regclass
  ) THEN
    ALTER TABLE "UserPackage"
    ADD CONSTRAINT "UserPackage_sessionsUsed_bounds_chk"
    CHECK (
      "sessionsUsed" >= 0
      AND "sessionsUsed" <= "sessionsTotal"
    )
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'UserPackage_minutesPerSession_positive_chk'
      AND conrelid = '"UserPackage"'::regclass
  ) THEN
    ALTER TABLE "UserPackage"
    ADD CONSTRAINT "UserPackage_minutesPerSession_positive_chk"
    CHECK ("minutesPerSession" IS NULL OR "minutesPerSession" > 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DiscountCode_percentage_range_chk'
      AND conrelid = '"DiscountCode"'::regclass
  ) THEN
    ALTER TABLE "DiscountCode"
    ADD CONSTRAINT "DiscountCode_percentage_range_chk"
    CHECK ("percentage" >= 1 AND "percentage" <= 100)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DiscountCode_usedCount_nonnegative_chk'
      AND conrelid = '"DiscountCode"'::regclass
  ) THEN
    ALTER TABLE "DiscountCode"
    ADD CONSTRAINT "DiscountCode_usedCount_nonnegative_chk"
    CHECK ("usedCount" >= 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DiscountCode_maxUses_positive_chk'
      AND conrelid = '"DiscountCode"'::regclass
  ) THEN
    ALTER TABLE "DiscountCode"
    ADD CONSTRAINT "DiscountCode_maxUses_positive_chk"
    CHECK ("maxUses" IS NULL OR "maxUses" > 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'DiscountCode_usedCount_within_max_chk'
      AND conrelid = '"DiscountCode"'::regclass
  ) THEN
    ALTER TABLE "DiscountCode"
    ADD CONSTRAINT "DiscountCode_usedCount_within_max_chk"
    CHECK ("maxUses" IS NULL OR "usedCount" <= "maxUses")
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'LearnerSessionFeedback_rating_range_chk'
      AND conrelid = '"LearnerSessionFeedback"'::regclass
  ) THEN
    ALTER TABLE "LearnerSessionFeedback"
    ADD CONSTRAINT "LearnerSessionFeedback_rating_range_chk"
    CHECK ("rating" >= 1 AND "rating" <= 5)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'SupportAttachment_fileSize_nonnegative_chk'
      AND conrelid = '"SupportAttachment"'::regclass
  ) THEN
    ALTER TABLE "SupportAttachment"
    ADD CONSTRAINT "SupportAttachment_fileSize_nonnegative_chk"
    CHECK ("fileSize" >= 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Order_amountCents_nonnegative_chk'
      AND conrelid = '"Order"'::regclass
  ) THEN
    ALTER TABLE "Order"
    ADD CONSTRAINT "Order_amountCents_nonnegative_chk"
    CHECK ("amountCents" >= 0)
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Availability_dayOfWeek_range_chk'
      AND conrelid = '"Availability"'::regclass
  ) THEN
    ALTER TABLE "Availability"
    ADD CONSTRAINT "Availability_dayOfWeek_range_chk"
    CHECK ("dayOfWeek" IS NULL OR ("dayOfWeek" >= 0 AND "dayOfWeek" <= 6))
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Availability_time_shape_and_order_chk'
      AND conrelid = '"Availability"'::regclass
  ) THEN
    ALTER TABLE "Availability"
    ADD CONSTRAINT "Availability_time_shape_and_order_chk"
    CHECK (
      "startTime" ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
      AND "endTime" ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
      AND (
        (split_part("startTime", ':', 1)::int * 60 + split_part("startTime", ':', 2)::int)
        <
        (split_part("endTime", ':', 1)::int * 60 + split_part("endTime", ':', 2)::int)
      )
    )
    NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Availability_recurrence_shape_chk'
      AND conrelid = '"Availability"'::regclass
  ) THEN
    ALTER TABLE "Availability"
    ADD CONSTRAINT "Availability_recurrence_shape_chk"
    CHECK (
      (
        "isRecurring" = TRUE
        AND "dayOfWeek" IS NOT NULL
        AND "specificDate" IS NULL
      )
      OR
      (
        "isRecurring" = FALSE
        AND "dayOfWeek" IS NULL
        AND "specificDate" IS NOT NULL
      )
    )
    NOT VALID;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Unique key hardening for active availability slots
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT "userId", "dayOfWeek", "startTime", "endTime"
      FROM "Availability"
      WHERE "isRecurring" = TRUE
        AND "status" = 'active'
        AND "dayOfWeek" IS NOT NULL
      GROUP BY 1, 2, 3, 4
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX IF NOT EXISTS "Availability_unique_active_recurring_slot_key"
      ON "Availability"("userId", "dayOfWeek", "startTime", "endTime")
      WHERE "isRecurring" = TRUE
        AND "status" = ''active''
        AND "dayOfWeek" IS NOT NULL
    ';
  ELSE
    RAISE NOTICE 'Skipped Availability_unique_active_recurring_slot_key due to existing duplicates';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT "userId", "specificDate", "startTime", "endTime"
      FROM "Availability"
      WHERE "isRecurring" = FALSE
        AND "status" = 'active'
        AND "specificDate" IS NOT NULL
      GROUP BY 1, 2, 3, 4
      HAVING COUNT(*) > 1
    ) duplicates
  ) THEN
    EXECUTE '
      CREATE UNIQUE INDEX IF NOT EXISTS "Availability_unique_active_specific_slot_key"
      ON "Availability"("userId", "specificDate", "startTime", "endTime")
      WHERE "isRecurring" = FALSE
        AND "status" = ''active''
        AND "specificDate" IS NOT NULL
    ';
  ELSE
    RAISE NOTICE 'Skipped Availability_unique_active_specific_slot_key due to existing duplicates';
  END IF;
END
$$;
