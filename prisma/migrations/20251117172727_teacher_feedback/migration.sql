/*
  Warnings:

  - You are about to drop the column `notes` on the `SessionFeedback` table. All the data in the column will be lost.
  - You are about to drop the column `rating` on the `SessionFeedback` table. All the data in the column will be lost.
  - You are about to drop the column `role` on the `SessionFeedback` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[sessionId]` on the table `SessionFeedback` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `teacherId` to the `SessionFeedback` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `SessionFeedback` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."SessionFeedback_sessionId_role_idx";

-- DropIndex
DROP INDEX "public"."SessionFeedback_sessionId_role_key";

-- AlterTable
ALTER TABLE "SessionFeedback" DROP COLUMN "notes",
DROP COLUMN "rating",
DROP COLUMN "role",
ADD COLUMN     "commentsOnSession" TEXT,
ADD COLUMN     "futureSteps" TEXT,
ADD COLUMN     "messageToLearner" TEXT,
ADD COLUMN     "teacherId" INTEGER NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SessionFeedback_sessionId_key" ON "SessionFeedback"("sessionId");

-- AddForeignKey
ALTER TABLE "SessionFeedback" ADD CONSTRAINT "SessionFeedback_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
