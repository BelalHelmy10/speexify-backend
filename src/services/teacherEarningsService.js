import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import crypto from "node:crypto";
import { getTeacherRateAt } from "./teacherRateService.js";
import { notifyOperationalAlert } from "../observability/alerts.js";

export const TEACHER_EARNINGS_CURRENCY = "EGP";
export const TEACHER_EARNING_SNAPSHOT_JOB_STATUS = Object.freeze({
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
});

const SNAPSHOT_JOB_LOCK_LEASE_MS = 10 * 60 * 1000;
const SNAPSHOT_JOB_BACKOFF_MS = [
  30 * 1000,
  2 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
];

export function isTeacherEarningsUnavailable(err) {
  return (
    err?.code === "P2021" ||
    /TeacherEarning|TeacherPayout|TeacherRateHistory|TeacherEarningSnapshotJob|does not exist|relation .* does not exist/i.test(
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

function getSnapshotRetryDelayMs(attempts) {
  return SNAPSHOT_JOB_BACKOFF_MS[
    Math.min(Math.max(Number(attempts) - 1, 0), SNAPSHOT_JOB_BACKOFF_MS.length - 1)
  ];
}

function getSnapshotErrorMessage(error) {
  return String(error?.message || error || "Unknown payroll snapshot error").slice(0, 1000);
}

/**
 * Transactional outbox insert. The update branch intentionally does nothing:
 * an existing FAILED/SUCCEEDED job must not be reset by a duplicate completion
 * request or a dashboard read.
 */
export async function enqueueTeacherEarningSnapshot(sessionId, db = prisma) {
  const session = await db.session.findUnique({
    where: { id: Number(sessionId) },
    select: { id: true, teacherId: true, status: true },
  });
  if (!session || session.status !== "completed" || !session.teacherId) return null;

  return db.teacherEarningSnapshotJob.upsert({
    where: { sessionId: session.id },
    update: {},
    create: {
      sessionId: session.id,
      teacherId: session.teacherId,
      status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PENDING,
      nextAttemptAt: new Date(),
    },
  });
}

/**
 * Completion and the payroll outbox row commit together. If the outbox write
 * fails, the session remains uncompleted and the caller can safely retry.
 */
export async function completeSessionWithTeacherEarningOutbox(
  sessionId,
  db = prisma
) {
  try {
    return await db.$transaction(async (tx) => {
      const completedAt = new Date();
      await tx.session.updateMany({
        where: { id: Number(sessionId), status: "scheduled" },
        data: { status: "completed", completedAt },
      });
      const session = await tx.session.findUnique({
        where: { id: Number(sessionId) },
        select: { id: true, teacherId: true, status: true, completedAt: true },
      });
      if (!session) {
        const error = new Error("Session not found");
        error.code = "SESSION_NOT_FOUND";
        throw error;
      }
      if (session.status !== "completed") {
        const error = new Error("Only scheduled sessions can be completed");
        error.code = "SESSION_NOT_COMPLETABLE";
        throw error;
      }
      const job = await enqueueTeacherEarningSnapshot(session.id, tx);
      return { session, job };
    });
  } catch (error) {
    if (![
      "SESSION_NOT_FOUND",
      "SESSION_NOT_COMPLETABLE",
    ].includes(error?.code)) {
      await notifyOperationalAlert({
        key: "teacher-earning-snapshot-outbox-write-failed",
        severity: "critical",
        title: "Teacher earning snapshot outbox write failed",
        actual: getSnapshotErrorMessage(error),
        context: { sessionId: Number(sessionId) },
      });
    }
    throw error;
  }
}

async function claimTeacherEarningSnapshotJob(jobId, db, workerId) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - SNAPSHOT_JOB_LOCK_LEASE_MS);
  const claimed = await db.teacherEarningSnapshotJob.updateMany({
    where: {
      id: Number(jobId),
      OR: [
        {
          status: {
            in: [
              TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PENDING,
              TEACHER_EARNING_SNAPSHOT_JOB_STATUS.FAILED,
            ],
          },
          nextAttemptAt: { lte: now },
        },
        {
          status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING,
          lockedAt: { lt: staleBefore },
        },
      ],
    },
    data: {
      status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING,
      lockedAt: now,
      lockedBy: workerId,
      lastAttemptAt: now,
    },
  });
  if (claimed.count !== 1) return null;
  return db.teacherEarningSnapshotJob.findUnique({ where: { id: Number(jobId) } });
}

export async function processTeacherEarningSnapshotJob(
  jobId,
  db = prisma,
  { workerId = `inline:${crypto.randomUUID()}` } = {}
) {
  const job = await claimTeacherEarningSnapshotJob(jobId, db, workerId);
  if (!job) return { ok: false, claimed: false };

  try {
    const earning = await ensureTeacherEarningForSession(job.sessionId, db, {
      teacherIdOverride: job.teacherId,
    });
    if (!earning) {
      const error = new Error("Completed session has no teacher payroll snapshot");
      error.code = "PAYROLL_SNAPSHOT_MISSING";
      throw error;
    }

    const settled = await db.teacherEarningSnapshotJob.updateMany({
      where: { id: job.id, status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING, lockedBy: workerId },
      data: {
        status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.SUCCEEDED,
        succeededAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    if (settled.count !== 1) return { ok: false, claimed: true, lostClaim: true };
    return { ok: true, claimed: true, earning };
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    const nextAttemptAt = new Date(Date.now() + getSnapshotRetryDelayMs(attempts));
    const message = getSnapshotErrorMessage(error);
    const failed = await db.teacherEarningSnapshotJob.updateMany({
      where: { id: job.id, status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING, lockedBy: workerId },
      data: {
        status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.FAILED,
        attempts,
        nextAttemptAt,
        lockedAt: null,
        lockedBy: null,
        lastError: message,
      },
    });

    if (failed.count === 1) {
      logger.error(
        { err: error, jobId: job.id, sessionId: job.sessionId, attempts, nextAttemptAt },
        "teacher earning snapshot job failed"
      );
      await notifyOperationalAlert({
        key: "teacher-earning-snapshot-failed",
        severity: "critical",
        title: "Teacher earning snapshot failed",
        actual: message,
        value: attempts,
        context: { jobId: job.id, sessionId: job.sessionId, teacherId: job.teacherId },
      });
    }
    return { ok: false, claimed: true, attempts, nextAttemptAt, error };
  }
}

export async function processDueTeacherEarningSnapshotJobs(
  db = prisma,
  {
    limit = 50,
    workerId = `worker:${crypto.randomUUID()}`,
  } = {}
) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - SNAPSHOT_JOB_LOCK_LEASE_MS);
  const jobs = await db.teacherEarningSnapshotJob.findMany({
    where: {
      OR: [
        {
          status: {
            in: [
              TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PENDING,
              TEACHER_EARNING_SNAPSHOT_JOB_STATUS.FAILED,
            ],
          },
          nextAttemptAt: { lte: now },
        },
        {
          status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING,
          lockedAt: { lt: staleBefore },
        },
      ],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: Math.max(1, Math.min(Number(limit) || 50, 500)),
    select: { id: true },
  });

  const results = [];
  for (const job of jobs) {
    const result = await processTeacherEarningSnapshotJob(job.id, db, { workerId });
    if (result.claimed) results.push({ jobId: job.id, ...result });
  }
  return results;
}

export async function getTeacherEarningsReconciliation(db = prisma) {
  try {
    const [completedSessions, earningRows, pendingSnapshotJobs, failedSnapshotJobs, processingSnapshotJobs] =
      await Promise.all([
        db.session.count({
          where: { status: "completed", teacherId: { not: null } },
        }),
        db.teacherEarning.count({
          where: {
            session: { status: "completed", teacherId: { not: null } },
          },
        }),
        db.teacherEarningSnapshotJob.count({
          where: { status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PENDING },
        }),
        db.teacherEarningSnapshotJob.count({
          where: { status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.FAILED },
        }),
        db.teacherEarningSnapshotJob.count({
          where: { status: TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING },
        }),
      ]);

    const missingEarnings = Math.max(0, completedSessions - earningRows);
    return {
      available: true,
      completedSessions,
      earningRows,
      missingEarnings,
      coveragePct:
        completedSessions > 0
          ? Number(((earningRows / completedSessions) * 100).toFixed(2))
          : 100,
      pendingSnapshotJobs,
      failedSnapshotJobs,
      processingSnapshotJobs,
      observedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (isTeacherEarningsUnavailable(error)) {
      return {
        available: false,
        completedSessions: 0,
        earningRows: 0,
        missingEarnings: 0,
        coveragePct: 0,
        pendingSnapshotJobs: 0,
        failedSnapshotJobs: 0,
        processingSnapshotJobs: 0,
        observedAt: new Date().toISOString(),
        errorCode: "EARNINGS_NOT_READY",
      };
    }
    throw error;
  }
}

export async function ensureTeacherEarningForSession(
  sessionId,
  db = prisma,
  {
    allowCreate = true,
    allowHistoricalBackfill = false,
    teacherIdOverride = null,
  } = {}
) {
  const session = await db.session.findUnique({
    where: { id: Number(sessionId) },
    select: {
      id: true,
      teacherId: true,
      status: true,
      startAt: true,
      endAt: true,
      completedAt: true,
      updatedAt: true,
      teacher: { select: { rateHourlyEgpPiastres: true, ratePerSessionEgpPiastres: true } },
    },
  });

  if (!session || session.status !== "completed") return null;

  const teacherId = session.teacherId || Number(teacherIdOverride) || null;
  if (!teacherId) return null;

  const existing = await db.teacherEarning.findUnique({
    where: { sessionId: session.id },
  });

  // The first row is the completion-time ledger snapshot. Once it exists,
  // neither normal synchronization nor rate changes may rewrite it.
  if (existing || !allowCreate) return existing || null;

  const minutes = durationMinutes(session.startAt, session.endAt);
  const snapshotAt = new Date(
    session.completedAt || session.updatedAt || session.endAt || session.startAt
  );
  const teacherRate = session.teacher || (teacherIdOverride
    ? await db.user.findUnique({
        where: { id: Number(teacherIdOverride) },
        select: {
          rateHourlyEgpPiastres: true,
          ratePerSessionEgpPiastres: true,
        },
      })
    : null);
  const rate = await getTeacherRateAt(teacherId, snapshotAt, db, {
    fallback: {
      rateHourlyEgpPiastres: teacherRate?.rateHourlyEgpPiastres,
      ratePerSessionEgpPiastres: teacherRate?.ratePerSessionEgpPiastres,
    },
    // A delayed historical sync may not silently use today's User rate.
    allowFallback: !allowHistoricalBackfill,
  });
  const calculation = calculateTeacherEarning({
    rateHourlyEgpPiastres: rate?.rateHourlyEgpPiastres,
    ratePerSessionEgpPiastres: rate?.ratePerSessionEgpPiastres,
    minutes,
  });

  try {
    return await db.teacherEarning.create({
      data: {
        teacherId,
        sessionId: session.id,
        amountMinor: calculation.amountMinor,
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        rateType: calculation.rateType,
        rateMinor: calculation.rateMinor,
        rateSnapshotAt: snapshotAt,
        rateEffectiveFrom: rate?.effectiveFrom || null,
        rateSnapshotSource: rate?.source || "not_configured",
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

export async function syncTeacherEarnings(
  teacherId,
  db = prisma,
  { allowHistoricalBackfill = false } = {}
) {
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
    await Promise.all(
      batch.map((session) =>
        ensureTeacherEarningForSession(session.id, db, {
          allowCreate: allowHistoricalBackfill,
          allowHistoricalBackfill,
        })
      )
    );
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
