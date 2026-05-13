-- CreateTable
CREATE TABLE "ClassroomMessage" (
    "id" TEXT NOT NULL,
    "sessionId" INTEGER NOT NULL,
    "senderId" INTEGER,
    "senderRole" TEXT NOT NULL,
    "senderName" TEXT,
    "body" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassroomMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassroomMessage_sessionId_createdAt_idx" ON "ClassroomMessage"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "ClassroomMessage_senderId_createdAt_idx" ON "ClassroomMessage"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "ClassroomMessage_deletedAt_idx" ON "ClassroomMessage"("deletedAt");

-- AddForeignKey
ALTER TABLE "ClassroomMessage" ADD CONSTRAINT "ClassroomMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassroomMessage" ADD CONSTRAINT "ClassroomMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

