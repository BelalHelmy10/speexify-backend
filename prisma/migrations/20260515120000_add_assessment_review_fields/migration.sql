ALTER TABLE "AssessmentSubmission"
  ADD COLUMN "cefr" TEXT,
  ADD COLUMN "feedback" TEXT,
  ADD COLUMN "reviewMeta" JSONB,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedById" INTEGER;

CREATE INDEX "AssessmentSubmission_status_updatedAt_idx"
  ON "AssessmentSubmission"("status", "updatedAt");

CREATE INDEX "AssessmentSubmission_reviewedById_reviewedAt_idx"
  ON "AssessmentSubmission"("reviewedById", "reviewedAt");

ALTER TABLE "AssessmentSubmission"
  ADD CONSTRAINT "AssessmentSubmission_reviewedById_fkey"
  FOREIGN KEY ("reviewedById")
  REFERENCES "User"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
