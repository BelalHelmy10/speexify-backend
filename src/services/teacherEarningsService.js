import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

export const TEACHER_EARNINGS_CURRENCY = "EGP";

export function isTeacherEarningsUnavailable(err) {
  return (
    err?.code === "P2021" ||
    /TeacherEarning|TeacherPayout|does not exist|relation .* does not exist/i.test(
      String(err?.message || "")
    )
  );
}

function durationMinutes(startAt, endAt) {
  const start = startAt ? new Date(startAt).getTime() : NaN;
  const end = endAt ? new Date(endAt).getTime() : NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 60;
  return Math.max(1, Math.round((end - start) / 60000));
}

export function calculateTeacherEarning({ rateHourlyEgpPiastres, ratePerSessionEgpPiastres, minutes }) {
  const safeMinutes = Number.isFinite(Number(minutes)) ? Number(minutes) : 60;
  if (Number.isInteger(rateHourlyEgpPiastres) && rateHourlyEgpPiastres > 0) {
    return {
      amountMinor: Math.round((safeMinutes * rateHourlyEgpPiastres) / 60),
      rateType: "hourly",
      rateMinor: rateHourlyEgpPiastres,
    };
  }
  if (Number.isInteger(ratePerSessionEgpPiastres) && ratePerSessionEgpPiastres > 0) {
    return {
      amountMinor: ratePerSessionEgpPiastres,
      rateType: "per_session",
      rateMinor: ratePerSessionEgpPiastres,
    };
  }
  return { amountMinor: 0, rateType: "none", rateMinor: null };
}

export function validatePayoutEntries(earningIds, entries) {
  const uniqueIds = new Set(earningIds);
  if (uniqueIds.size !== earningIds.length || entries.length !== uniqueIds.size) {
    const error = new Error("Some earnings are missing or already paid");
    error.code = "INVALID_EARNINGS";
    throw error;
  }

  if (entries.some((entry) => entry.amountMinor <= 0)) {
    const error = new Error("Some selected sessions do not have a configured EGP rate");
    error.code = "RATE_NOT_CONFIGURED";
    throw error;
  }

  return entries.reduce((sum, entry) => sum + entry.amountMinor, 0);
}

export async function ensureTeacherEarningForSession(sessionId, db = prisma) {
  const session = await db.session.findUnique({
    where: { id: Number(sessionId) },
    select: {
      id: true,
      teacherId: true,
      status: true,
      startAt: true,
      endAt: true,
      teacher: { select: { rateHourlyEgpPiastres: true, ratePerSessionEgpPiastres: true } },
    },
  });

  if (!session || session.status !== "completed" || !session.teacherId) return null;

  const minutes = durationMinutes(session.startAt, session.endAt);
  const calculation = calculateTeacherEarning({
    rateHourlyEgpPiastres: session.teacher?.rateHourlyEgpPiastres,
    ratePerSessionEgpPiastres: session.teacher?.ratePerSessionEgpPiastres,
    minutes,
  });

  const existing = await db.teacherEarning.findUnique({
    where: { sessionId: session.id },
  });

  // A session can be snapshotted before the teacher's rate is configured.
  // Hydrate only those incomplete, still-pending snapshots once a valid rate
  // exists; settled earnings and valid historical snapshots stay immutable.
  if (existing) {
    if (
      existing.status === "PENDING" &&
      existing.rateType === "none" &&
      calculation.amountMinor > 0
    ) {
      return db.teacherEarning.update({
        where: { id: existing.id },
        data: {
          teacherId: session.teacherId,
          amountMinor: calculation.amountMinor,
          currencyCode: TEACHER_EARNINGS_CURRENCY,
          rateType: calculation.rateType,
          rateMinor: calculation.rateMinor,
          durationMinutes: minutes,
        },
      });
    }
    return existing;
  }

  try {
    return await db.teacherEarning.create({
      data: {
        teacherId: session.teacherId,
        sessionId: session.id,
        amountMinor: calculation.amountMinor,
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        rateType: calculation.rateType,
        rateMinor: calculation.rateMinor,
        durationMinutes: minutes,
        status: "PENDING",
      },
    });
  } catch (err) {
    // Multiple dashboard requests can synchronize the same completed session
    // at once. PostgreSQL may surface the unique sessionId race as P2002 even
    // though the earning now exists; reuse the winner's immutable snapshot.
    const target = Array.isArray(err?.meta?.target) ? err.meta.target : [];
    if (err?.code === "P2002" && target.includes("sessionId")) {
      const existing = await db.teacherEarning.findUnique({
        where: { sessionId: session.id },
      });
      if (existing) return existing;
    }
    throw err;
  }
}

// Earnings must never make a session completion fail. If deployment briefly
// runs before the migration, the backfill command can safely repair the gap.
export async function snapshotTeacherEarningSafely(sessionId, db = prisma) {
  try {
    return await ensureTeacherEarningForSession(sessionId, db);
  } catch (err) {
    logger.error({ err, sessionId }, "teacher earning snapshot deferred");
    return null;
  }
}

export async function syncTeacherEarnings(teacherId, db = prisma) {
  const sessions = await db.session.findMany({
    where: { teacherId: Number(teacherId), status: "completed" },
    select: { id: true },
    orderBy: { startAt: "asc" },
  });

  // Keep the read endpoint responsive when a teacher has many completed
  // sessions, while limiting concurrent writes so a large history does not
  // overwhelm the database connection pool.
  const batchSize = 8;
  for (let index = 0; index < sessions.length; index += batchSize) {
    const batch = sessions.slice(index, index + batchSize);
    await Promise.all(batch.map((session) => ensureTeacherEarningForSession(session.id, db)));
  }
  return sessions.length;
}

export async function getTeacherEarningsSummary(teacherId, db = prisma, { sync = true } = {}) {
  if (sync) await syncTeacherEarnings(teacherId, db);
  const [pending, paid, pendingAdjustments, paidAdjustments, recentPayouts, trendEntries, adjustmentEntries] = await Promise.all([
    db.teacherEarning.aggregate({
      where: { teacherId: Number(teacherId), status: "PENDING" },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    db.teacherEarning.aggregate({
      where: { teacherId: Number(teacherId), status: "PAID" },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    db.teacherEarningAdjustment.aggregate({
      where: { teacherId: Number(teacherId), status: "PENDING" },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    db.teacherEarningAdjustment.aggregate({
      where: { teacherId: Number(teacherId), status: "PAID" },
      _sum: { amountMinor: true },
      _count: { _all: true },
    }),
    db.teacherPayout.findMany({
      where: { teacherId: Number(teacherId) },
      orderBy: { paidAt: "desc" },
      take: 5,
      select: { id: true, totalMinor: true, currencyCode: true, paymentMethod: true, paidAt: true, paymentReference: true },
    }),
    db.teacherEarning.findMany({
      where: { teacherId: Number(teacherId) },
      select: {
        amountMinor: true,
        status: true,
        createdAt: true,
        session: { select: { startAt: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.teacherEarningAdjustment.findMany({
      where: { teacherId: Number(teacherId) },
      select: { amountMinor: true, status: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const now = new Date();
  const monthlyTrend = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (5 - index), 1));
    const month = date.toISOString().slice(0, 7);
    return { month, totalMinor: 0, pendingMinor: 0, paidMinor: 0 };
  });
  const trendByMonth = new Map(monthlyTrend.map((item) => [item.month, item]));
  for (const entry of trendEntries) {
    const trendDate = entry.session?.startAt || entry.createdAt;
    const bucket = trendByMonth.get(new Date(trendDate).toISOString().slice(0, 7));
    if (!bucket) continue;
    bucket.totalMinor += entry.amountMinor;
    if (entry.status === "PAID") bucket.paidMinor += entry.amountMinor;
    else bucket.pendingMinor += entry.amountMinor;
  }
  for (const entry of adjustmentEntries) {
    const bucket = trendByMonth.get(new Date(entry.createdAt).toISOString().slice(0, 7));
    if (!bucket) continue;
    bucket.totalMinor += entry.amountMinor;
    if (entry.status === "PAID") bucket.paidMinor += entry.amountMinor;
    else bucket.pendingMinor += entry.amountMinor;
  }

  return {
    currencyCode: TEACHER_EARNINGS_CURRENCY,
    pendingMinor: (pending._sum.amountMinor || 0) + (pendingAdjustments._sum.amountMinor || 0),
    pendingCount: pending._count._all + pendingAdjustments._count._all,
    paidMinor: (paid._sum.amountMinor || 0) + (paidAdjustments._sum.amountMinor || 0),
    paidCount: paid._count._all + paidAdjustments._count._all,
    recentPayouts,
    monthlyTrend,
  };
}
