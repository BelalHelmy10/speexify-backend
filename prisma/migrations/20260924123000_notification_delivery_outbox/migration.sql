CREATE TABLE "NotificationDelivery" (
  "id" SERIAL NOT NULL,
  "userId" INTEGER,
  "notificationId" INTEGER,
  "channel" TEXT NOT NULL DEFAULT 'EMAIL',
  "eventType" TEXT NOT NULL,
  "recipient" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "bodyHtml" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastAttemptAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationDelivery_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "NotificationDelivery_notificationId_fkey"
    FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

ALTER TABLE "NotificationDelivery"
  ADD CONSTRAINT "NotificationDelivery_channel_check"
    CHECK ("channel" = 'EMAIL'),
  ADD CONSTRAINT "NotificationDelivery_status_check"
    CHECK ("status" IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
  ADD CONSTRAINT "NotificationDelivery_attempts_check"
    CHECK ("attempts" >= 0);

CREATE INDEX "NotificationDelivery_status_nextAttemptAt_idx"
  ON "NotificationDelivery"("status", "nextAttemptAt");
CREATE INDEX "NotificationDelivery_userId_createdAt_idx"
  ON "NotificationDelivery"("userId", "createdAt");
CREATE INDEX "NotificationDelivery_notificationId_idx"
  ON "NotificationDelivery"("notificationId");
