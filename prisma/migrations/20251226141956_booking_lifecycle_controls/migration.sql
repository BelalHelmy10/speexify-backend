-- CreateEnum
CREATE TYPE "CreditTxnKind" AS ENUM ('CONSUME', 'REFUND', 'PENALTY');

-- AlterTable
ALTER TABLE "SessionParticipant" ADD COLUMN     "creditConsumedAt" TIMESTAMP(3),
ADD COLUMN     "creditPackId" INTEGER,
ADD COLUMN     "creditTxnKind" "CreditTxnKind",
ADD COLUMN     "penaltyAppliedAt" TIMESTAMP(3),
ADD COLUMN     "penaltyPackId" INTEGER,
ADD COLUMN     "penaltyTxnKind" "CreditTxnKind";

-- CreateTable
CREATE TABLE "BookingPolicy" (
    "id" SERIAL NOT NULL,
    "cancelFreeCutoffMin" INTEGER NOT NULL DEFAULT 720,
    "rescheduleFreeCutoffMin" INTEGER NOT NULL DEFAULT 720,
    "cancelPenaltyCredits" INTEGER NOT NULL DEFAULT 0,
    "noShowPenaltyCredits" INTEGER NOT NULL DEFAULT 1,
    "autoMarkNoShowAfterMin" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BookingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionWaitlist" (
    "id" SERIAL NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionWaitlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionWaitlist_sessionId_status_createdAt_idx" ON "SessionWaitlist"("sessionId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "SessionWaitlist_userId_status_idx" ON "SessionWaitlist"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SessionWaitlist_sessionId_userId_key" ON "SessionWaitlist"("sessionId", "userId");

-- AddForeignKey
ALTER TABLE "SessionWaitlist" ADD CONSTRAINT "SessionWaitlist_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionWaitlist" ADD CONSTRAINT "SessionWaitlist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
