/*
  Warnings:

  - You are about to drop the column `joinUrl` on the `Session` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Session" DROP COLUMN "joinUrl",
ADD COLUMN     "meetingUrl" TEXT;
