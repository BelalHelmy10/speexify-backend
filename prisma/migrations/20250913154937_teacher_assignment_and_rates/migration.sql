-- AlterTable
ALTER TABLE "public"."Session" ADD COLUMN     "teacherId" INTEGER;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "rateHourlyCents" INTEGER,
ADD COLUMN     "ratePerSessionCents" INTEGER;

-- CreateIndex
CREATE INDEX "User_role_idx" ON "public"."User"("role");

-- AddForeignKey
ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
