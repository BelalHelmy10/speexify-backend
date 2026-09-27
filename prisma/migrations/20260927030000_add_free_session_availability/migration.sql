ALTER TABLE "FreeSessionRequest"
  ALTER COLUMN "preferredSlots" DROP NOT NULL,
  ADD COLUMN "preferredDays" JSONB,
  ADD COLUMN "preferredTimes" JSONB;
