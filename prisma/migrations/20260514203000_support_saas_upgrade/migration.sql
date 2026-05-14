-- Support SaaS upgrade: operational metadata for SLA, satisfaction, tagging, and AI assist.
ALTER TABLE "SupportTicket"
  ADD COLUMN "firstResponseAt" TIMESTAMP(3),
  ADD COLUMN "lastCustomerReplyAt" TIMESTAMP(3),
  ADD COLUMN "lastStaffReplyAt" TIMESTAMP(3),
  ADD COLUMN "slaDueAt" TIMESTAMP(3),
  ADD COLUMN "closedAt" TIMESTAMP(3),
  ADD COLUMN "reopenedAt" TIMESTAMP(3),
  ADD COLUMN "reopenCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "satisfactionRating" INTEGER,
  ADD COLUMN "satisfactionComment" TEXT,
  ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'widget',
  ADD COLUMN "relatedSessionId" INTEGER,
  ADD COLUMN "relatedPaymentId" INTEGER,
  ADD COLUMN "assignedTeamId" INTEGER,
  ADD COLUMN "aiStatus" TEXT NOT NULL DEFAULT 'off';

CREATE INDEX "SupportTicket_slaDueAt_idx" ON "SupportTicket"("slaDueAt");
CREATE INDEX "SupportTicket_lastCustomerReplyAt_idx" ON "SupportTicket"("lastCustomerReplyAt");
