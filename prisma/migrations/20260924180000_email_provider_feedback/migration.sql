-- Provider delivery feedback and suppression handling.
ALTER TABLE "NotificationDelivery"
  DROP CONSTRAINT IF EXISTS "NotificationDelivery_status_check";

ALTER TABLE "NotificationDelivery"
  ADD COLUMN "providerMessageId" TEXT,
  ADD COLUMN "providerEventId" TEXT,
  ADD COLUMN "providerEventType" TEXT,
  ADD COLUMN "providerEventAt" TIMESTAMP(3),
  ADD CONSTRAINT "NotificationDelivery_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED'));

CREATE TABLE "EmailSuppression" (
  "id" SERIAL NOT NULL,
  "email" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'resend',
  "providerEventId" TEXT,
  "lastEventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EmailSuppression_email_key" UNIQUE ("email")
);

CREATE INDEX "NotificationDelivery_providerMessageId_idx"
  ON "NotificationDelivery"("providerMessageId");
CREATE INDEX "NotificationDelivery_providerEventId_idx"
  ON "NotificationDelivery"("providerEventId");
CREATE INDEX "EmailSuppression_reason_lastEventAt_idx"
  ON "EmailSuppression"("reason", "lastEventAt");
CREATE INDEX "EmailSuppression_providerEventId_idx"
  ON "EmailSuppression"("providerEventId");
