CREATE TABLE "FreeSessionRequest" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "goal" TEXT NOT NULL,
    "preferredSlots" JSONB NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FreeSessionRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FreeSessionRequest_status_createdAt_idx"
  ON "FreeSessionRequest"("status", "createdAt");
CREATE INDEX "FreeSessionRequest_phone_idx"
  ON "FreeSessionRequest"("phone");
CREATE INDEX "FreeSessionRequest_email_idx"
  ON "FreeSessionRequest"("email");
