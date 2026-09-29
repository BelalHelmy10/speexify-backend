ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "marketingPhoneConsentAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "marketingPhoneConsentSource" TEXT,
  ADD COLUMN IF NOT EXISTS "marketingPhoneConsentVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "marketingPhoneOptOutAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_phone_idx" ON "User"("phone");
CREATE INDEX IF NOT EXISTS "User_marketingPhoneConsentAt_idx" ON "User"("marketingPhoneConsentAt");
