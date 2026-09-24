-- Keep bounded teacher earnings trend queries index-backed.
CREATE INDEX IF NOT EXISTS "TeacherEarning_teacherId_createdAt_idx"
  ON "TeacherEarning"("teacherId", "createdAt");

CREATE INDEX IF NOT EXISTS "TeacherEarningAdjustment_teacherId_createdAt_idx"
  ON "TeacherEarningAdjustment"("teacherId", "createdAt");
