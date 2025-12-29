-- CreateEnum
CREATE TYPE "SupportPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterTable
ALTER TABLE "SupportTicket" ADD COLUMN     "assignedToId" INTEGER,
ADD COLUMN     "priority" "SupportPriority" NOT NULL DEFAULT 'NORMAL';

-- CreateTable
CREATE TABLE "SupportInternalNote" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "authorId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportInternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportInternalNote_ticketId_createdAt_idx" ON "SupportInternalNote"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportInternalNote_authorId_idx" ON "SupportInternalNote"("authorId");

-- CreateIndex
CREATE INDEX "SupportTicket_priority_updatedAt_idx" ON "SupportTicket"("priority", "updatedAt");

-- CreateIndex
CREATE INDEX "SupportTicket_assignedToId_updatedAt_idx" ON "SupportTicket"("assignedToId", "updatedAt");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInternalNote" ADD CONSTRAINT "SupportInternalNote_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInternalNote" ADD CONSTRAINT "SupportInternalNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
