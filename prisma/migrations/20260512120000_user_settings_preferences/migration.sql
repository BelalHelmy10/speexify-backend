ALTER TABLE "User"
  ADD COLUMN "language" TEXT DEFAULT 'en',
  ADD COLUMN "notificationPreferences" JSONB,
  ADD COLUMN "calendarFeedRevokedAt" TIMESTAMP(3),
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
