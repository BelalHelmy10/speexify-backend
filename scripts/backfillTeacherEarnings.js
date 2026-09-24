import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import {
  syncTeacherEarnings,
  TEACHER_EARNINGS_CURRENCY,
} from "../src/services/teacherEarningsService.js";
import { getTeacherRateAt } from "../src/services/teacherRateService.js";

const apply = process.argv.includes("--apply");

async function main() {
  const tableCheck = await prisma.$queryRaw`
    SELECT
      to_regclass('public."TeacherEarning"')::text AS earning_table,
      to_regclass('public."TeacherRateHistory"')::text AS rate_history_table
  `;
  if (!tableCheck[0]?.earning_table || !tableCheck[0]?.rate_history_table) {
    console.error("Teacher earning tables are not available yet. Run the additive Prisma migrations before backfilling.");
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
    const completedSessions = await prisma.session.findMany({
      where: { teacherId: teacher.id, status: "completed" },
      select: { completedAt: true, updatedAt: true, endAt: true, startAt: true },
    });
    const missing = Math.max(0, completedSessions.length - teacher._count.teacherEarnings);
    let unresolvedRates = 0;
    for (const session of completedSessions) {
      const rate = await getTeacherRateAt(
        teacher.id,
        session.completedAt || session.updatedAt || session.endAt || session.startAt,
        prisma
      );
      if (!rate) unresolvedRates += 1;
    }
    console.log(
      `- teacher ${teacher.id}: ${missing} missing entries; ` +
        `${completedSessions.length - unresolvedRates} resolved historical rates; ` +
        `${unresolvedRates} NOT CONFIGURED`
    );

    if (apply && missing > 0) {
      await syncTeacherEarnings(teacher.id, prisma, {
        allowHistoricalBackfill: true,
      });
    }
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
