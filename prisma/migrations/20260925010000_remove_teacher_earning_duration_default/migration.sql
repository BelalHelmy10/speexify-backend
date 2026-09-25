-- Missing or invalid session timestamps must not silently become a payable
-- 60-minute earning. The application now rejects those sessions explicitly.
ALTER TABLE "TeacherEarning"
  ALTER COLUMN "durationMinutes" DROP DEFAULT;
