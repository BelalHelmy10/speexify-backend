/*
  Warnings:

  - You are about to drop the column `meetingUrl` on the `Session` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Session" DROP COLUMN "meetingUrl",
ADD COLUMN     "joinUrl" TEXT;
