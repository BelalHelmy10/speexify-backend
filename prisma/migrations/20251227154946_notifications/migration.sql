/*
  Warnings:

  - You are about to drop the column `creditConsumedAt` on the `SessionParticipant` table. All the data in the column will be lost.
  - You are about to drop the column `creditPackId` on the `SessionParticipant` table. All the data in the column will be lost.
  - You are about to drop the column `creditTxnKind` on the `SessionParticipant` table. All the data in the column will be lost.
  - You are about to drop the column `penaltyAppliedAt` on the `SessionParticipant` table. All the data in the column will be lost.
  - You are about to drop the column `penaltyPackId` on the `SessionParticipant` table. All the data in the column will be lost.
  - You are about to drop the column `penaltyTxnKind` on the `SessionParticipant` table. All the data in the column will be lost.
  - You are about to drop the `BookingPolicy` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SessionWaitlist` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."SessionWaitlist" DROP CONSTRAINT "SessionWaitlist_sessionId_fkey";

-- DropForeignKey
ALTER TABLE "public"."SessionWaitlist" DROP CONSTRAINT "SessionWaitlist_userId_fkey";

-- AlterTable
ALTER TABLE "SessionParticipant" DROP COLUMN "creditConsumedAt",
DROP COLUMN "creditPackId",
DROP COLUMN "creditTxnKind",
DROP COLUMN "penaltyAppliedAt",
DROP COLUMN "penaltyPackId",
DROP COLUMN "penaltyTxnKind";

-- DropTable
DROP TABLE "public"."BookingPolicy";

-- DropTable
DROP TABLE "public"."SessionWaitlist";

-- DropEnum
DROP TYPE "public"."CreditTxnKind";

-- CreateTable
CREATE TABLE "Notification" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
