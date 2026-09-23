import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";

async function main() {
  const tableCheck = await prisma.$queryRaw`
    SELECT to_regclass('public."TeacherEarning"')::text AS table_name
  `;
  const migrationReady = Boolean(tableCheck[0]?.table_name);

  const teachers = await prisma.user.findMany({
    where: { role: "teacher" },
    select: {
      id: true,
      name: true,
      rateHourlyCents: true,
      ratePerSessionCents: true,
      ...(migrationReady
        ? {
            rateHourlyEgpPiastres: true,
            ratePerSessionEgpPiastres: true,
            _count: { select: { teacherEarnings: true } },
          }
        : {}),
    },
    orderBy: { id: "asc" },
  });

  console.log(`Teacher earnings preflight (${migrationReady ? "migration found" : "migration pending"})`);
  console.log(`- teachers: ${teachers.length}`);

  if (!migrationReady) {
    console.log("- status: NOT READY — apply the additive Prisma migration first");
    for (const teacher of teachers) {
      const legacyConfigured = Boolean(teacher.rateHourlyCents || teacher.ratePerSessionCents);
      console.log(`- teacher ${teacher.id}: EGP rate ${legacyConfigured ? "requires explicit confirmation" : "not configured"}`);
    }
    return 2;
  }

  let needsAction = false;
  for (const teacher of teachers) {
    const hasRate = Boolean(teacher.rateHourlyEgpPiastres || teacher.ratePerSessionEgpPiastres);
    const completedSessions = await prisma.session.count({
      where: { teacherId: teacher.id, status: "completed" },
    });
    const earningEntries = teacher._count.teacherEarnings;
    const missingEntries = Math.max(0, completedSessions - earningEntries);
    if (!hasRate || missingEntries > 0) needsAction = true;
    console.log(
      `- teacher ${teacher.id}: EGP rate ${hasRate ? "configured" : "NOT CONFIGURED"}; ` +
        `${completedSessions} completed sessions; ${missingEntries} missing earning entries`,
    );
  }

  if (needsAction) {
    console.log("- status: ACTION REQUIRED — confirm EGP rates and/or run the backfill");
    return 2;
  }

  console.log("- status: READY — rates and earning entries are present");
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error("Teacher earnings preflight failed:", err?.message || err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
