import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { syncTeacherEarnings, TEACHER_EARNINGS_CURRENCY } from "../src/services/teacherEarningsService.js";

const apply = process.argv.includes("--apply");

async function main() {
  const tableCheck = await prisma.$queryRaw`SELECT to_regclass('public."TeacherEarning"')::text AS table_name`;
  if (!tableCheck[0]?.table_name) {
    console.error("TeacherEarning is not available yet. Run the additive Prisma migration before backfilling.");
    return 2;
  }

  const teachers = await prisma.user.findMany({
    where: { role: "teacher" },
    select: {
      id: true,
      name: true,
      email: true,
      rateHourlyEgpPiastres: true,
      ratePerSessionEgpPiastres: true,
      _count: { select: { teachingSessions: true, teacherEarnings: true } },
    },
    orderBy: { id: "asc" },
  });

  console.log(`${apply ? "Applying" : "Dry run"} teacher earnings backfill in ${TEACHER_EARNINGS_CURRENCY}.`);
  for (const teacher of teachers) {
    const completedSessions = await prisma.session.count({
      where: { teacherId: teacher.id, status: "completed" },
    });
    const missing = Math.max(0, completedSessions - teacher._count.teacherEarnings);
    const rate = teacher.rateHourlyEgpPiastres || teacher.ratePerSessionEgpPiastres;
    const rateLabel = rate ? `${rate} piastres` : "NOT CONFIGURED";
    console.log(`- teacher ${teacher.id}: ${missing} missing entries; EGP rate: ${rateLabel}`);

    if (apply && missing > 0) await syncTeacherEarnings(teacher.id);
  }

  if (!apply) console.log("No data was changed. Re-run with --apply after confirming every EGP rate.");
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error("Teacher earnings backfill failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
