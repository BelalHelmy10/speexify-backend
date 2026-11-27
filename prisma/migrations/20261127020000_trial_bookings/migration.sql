CREATE TABLE "TrialBookingSettings" (
 "id" INTEGER PRIMARY KEY DEFAULT 1 CHECK ("id" = 1),
 "leadHours" INTEGER NOT NULL DEFAULT 12 CHECK ("leadHours" BETWEEN 0 AND 168),
 "horizonDays" INTEGER NOT NULL DEFAULT 14 CHECK ("horizonDays" BETWEEN 1 AND 90),
 "durationMin" INTEGER NOT NULL DEFAULT 30 CHECK ("durationMin" BETWEEN 15 AND 120),
 "bufferMin" INTEGER NOT NULL DEFAULT 0 CHECK ("bufferMin" BETWEEN 0 AND 60)
);
INSERT INTO "TrialBookingSettings" ("id") VALUES (1);
CREATE TABLE "TrialSlot" (
 "id" SERIAL PRIMARY KEY, "startAt" TIMESTAMP(3) NOT NULL, "endAt" TIMESTAMP(3) NOT NULL,
 "bufferMin" INTEGER NOT NULL DEFAULT 0 CHECK ("bufferMin" BETWEEN 0 AND 60),
 "capacity" INTEGER NOT NULL DEFAULT 1 CHECK ("capacity" BETWEEN 1 AND 100),
 "reservedCount" INTEGER NOT NULL DEFAULT 0,
 "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "TrialSlot_count_check" CHECK ("reservedCount" BETWEEN 0 AND "capacity"),
 CONSTRAINT "TrialSlot_duration_check" CHECK ("endAt" > "startAt")
);
CREATE UNIQUE INDEX "TrialSlot_startAt_key" ON "TrialSlot"("startAt");
CREATE INDEX "TrialSlot_enabled_startAt_idx" ON "TrialSlot"("enabled", "startAt");
CREATE TABLE "TrialBooking" (
 "id" TEXT PRIMARY KEY, "tokenHash" TEXT NOT NULL, "slotId" INTEGER NOT NULL,
 "name" TEXT NOT NULL, "phone" TEXT NOT NULL, "activePhone" TEXT,
 "locale" TEXT NOT NULL DEFAULT 'en', "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
 "status" TEXT NOT NULL DEFAULT 'RESERVED' CHECK ("status" IN ('RESERVED','CONFIRMED','COMPLETED','CANCELLED','NO_SHOW')),
 "trainerId" INTEGER, "notes" TEXT NOT NULL DEFAULT '',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "TrialBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "TrialSlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT "TrialBooking_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TrialBooking_tokenHash_key" ON "TrialBooking"("tokenHash");
CREATE UNIQUE INDEX "TrialBooking_activePhone_key" ON "TrialBooking"("activePhone");
CREATE INDEX "TrialBooking_slotId_status_idx" ON "TrialBooking"("slotId", "status");
CREATE INDEX "TrialBooking_trainerId_status_idx" ON "TrialBooking"("trainerId", "status");
CREATE INDEX "TrialBooking_phone_idx" ON "TrialBooking"("phone");
