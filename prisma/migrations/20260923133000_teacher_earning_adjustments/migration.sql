-- CreateTable
CREATE TABLE "TeacherEarningAdjustment" (
    "id" SERIAL NOT NULL,
    "teacherId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'EGP',
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),
    "payoutId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeacherEarningAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeacherEarningAdjustment_teacherId_status_createdAt_idx" ON "TeacherEarningAdjustment"("teacherId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TeacherEarningAdjustment_payoutId_idx" ON "TeacherEarningAdjustment"("payoutId");

-- AddForeignKey
ALTER TABLE "TeacherEarningAdjustment" ADD CONSTRAINT "TeacherEarningAdjustment_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherEarningAdjustment" ADD CONSTRAINT "TeacherEarningAdjustment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeacherEarningAdjustment" ADD CONSTRAINT "TeacherEarningAdjustment_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "TeacherPayout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
