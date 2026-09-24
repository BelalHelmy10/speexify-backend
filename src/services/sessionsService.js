// src/services/sessionsService.js
import { prisma } from "../lib/prisma.js";
import {
  completeSessionWithTeacherEarningOutbox,
  processTeacherEarningSnapshotJob,
} from "./teacherEarningsService.js";
import { logger } from "../lib/logger.js";

async function completeSessionAndQueueTeacherPayroll(sessionId) {
  const completion = await completeSessionWithTeacherEarningOutbox(sessionId);
  if (!completion.job) return completion;

  try {
    const payroll = await processTeacherEarningSnapshotJob(completion.job.id);
    if (!payroll.ok) {
      logger.warn(
        { jobId: completion.job.id, sessionId },
        "teacher payroll snapshot queued for retry"
      );
    }
  } catch (error) {
    logger.error(
      { err: error, jobId: completion.job.id, sessionId },
      "teacher payroll snapshot processor unavailable"
    );
  }

  return completion;
}

// Re-used in many places to check time overlaps
export function overlapsFilter(startAt, endAt) {
  const end = endAt ? new Date(endAt) : new Date("2999-12-31");
  return {
    startAt: { lt: end },
    OR: [{ endAt: { gt: new Date(startAt) } }, { endAt: null }],
  };
}

/**
 * Find conflicting sessions for learner / teacher
 * Checks BOTH participant membership AND legacy userId field
 */
export async function findSessionConflictsWithClient(
  db,
  {
    startAt,
    endAt,
    userId,
    teacherId,
    excludeId,
  }
) {
  const whereCommon = {
    status: { not: "canceled" },
    ...(excludeId ? { id: { not: excludeId } } : {}),
    AND: [overlapsFilter(startAt, endAt)],
  };

  const clauses = [];

  // Learner conflict: legacy userId OR participant membership
  if (userId) {
    clauses.push({
      ...whereCommon,
      OR: [
        { userId: Number(userId) },
        {
          participants: {
            some: { userId: Number(userId), status: { not: "canceled" } },
          },
        },
      ],
    });
  }

  // Teacher conflict: teacherId still lives on Session
  if (teacherId) {
    clauses.push({ ...whereCommon, teacherId: Number(teacherId) });
  }

  if (!clauses.length) return [];

  return db.session.findMany({
    where: { OR: clauses },
    select: {
      id: true,
      title: true,
      startAt: true,
      endAt: true,
      userId: true,
      teacherId: true,
      status: true,
      type: true,
    },
    orderBy: { startAt: "asc" },
  });
}

export async function findSessionConflicts(args) {
  return findSessionConflictsWithClient(prisma, args);
}

/**
 * Serialize writes that can create overlapping sessions for the same
 * learner/teacher. PostgreSQL advisory locks are transaction-scoped, so the
 * lock is released automatically on commit/rollback and works across API
 * instances without a process-local mutex.
 */
export async function lockSchedulingResources(
  db,
  { learnerIds = [], teacherId = null } = {}
) {
  const keys = [
    ...learnerIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
      .map((id) => `learner:${id}`),
    ...(teacherId ? [`teacher:${Number(teacherId)}`] : []),
  ];

  for (const key of [...new Set(keys)].sort()) {
    await db.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
    `;
  }
}

/**
 * How many total remaining credits does a user have right now?
 */
export async function getRemainingCredits(userId, db = prisma) {
  const packs = await db.userPackage.findMany({
    where: {
      userId: Number(userId),
      status: "active",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { sessionsTotal: true, sessionsUsed: true },
  });
  return packs.reduce(
    (sum, p) =>
      sum + Math.max(0, Number(p.sessionsTotal) - Number(p.sessionsUsed || 0)),
    0
  );
}

/**
 * Take 1 credit from the newest active pack that still has remaining credits.
 * Accepts either the root Prisma client or an active transaction client.
 */
export async function consumeOneCreditWithClient(db, userId, sessionId) {
  const uid = Number(userId);
  const now = new Date();
  if (!Number.isSafeInteger(Number(sessionId)) || Number(sessionId) <= 0) throw new Error("Session ID required for credit debit");
  const booking = await db.session.findUnique({where: {id: Number(sessionId)}, select: {type: true, startAt: true, endAt: true}});
  if (!booking) throw new Error("Session not found for credit debit");
  const requiredMinutes = booking.endAt ? Math.ceil((new Date(booking.endAt) - new Date(booking.startAt)) / 60000) : null;
  const previous = await db.creditDebit.findFirst({ where: {sessionId: Number(sessionId), userId: uid, reversedAt: null} });
  if (previous) return {ok: true, packId: previous.userPackageId, alreadyConsumed: true};

  const candidatePacks = await db.userPackage.findMany({
    where: {
      userId: uid,
      status: "active",
      lessonType: booking.type,
      ...(requiredMinutes ? {minutesPerSession: {gte: requiredMinutes}} : {}),
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      userId: true,
      sessionsTotal: true,
    },
  });

  for (const pack of candidatePacks) {
    const consumed = await db.userPackage.updateMany({
      where: {
        id: pack.id,
        userId: uid,
        status: "active",
        sessionsTotal: pack.sessionsTotal,
        sessionsUsed: { lt: pack.sessionsTotal },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { sessionsUsed: { increment: 1 } },
    });

    if (consumed.count !== 1) {
      continue;
    }

    const updated = await db.userPackage.findUnique({
      where: { id: pack.id },
      select: { sessionsTotal: true, sessionsUsed: true },
    });

    if (!updated) {
      logger.error(
        { packId: pack.id, userId: uid },
        "[credits] Pack missing after consume"
      );
      return { ok: false, reason: "no_credits" };
    }

    await db.creditDebit.create({data: {sessionId: Number(sessionId), userId: uid, userPackageId: pack.id}});
    return {
      ok: true,
      packId: pack.id,
      remaining: updated.sessionsTotal - updated.sessionsUsed,
    };
  }

  return { ok: false, reason: "no_credits" };
}

/**
 * Take 1 credit from the newest active pack that still has remaining credits.
 */
export async function consumeOneCredit(userId, sessionId) {
  return prisma.$transaction((tx) => {
    return consumeOneCreditWithClient(tx, userId, sessionId);
  });
}

/**
 * Give back 1 credit to the newest pack that has at least 1 used.
 */
export async function refundOneCreditWithClient(tx, userId, sessionId) {
  if (!Number.isSafeInteger(Number(sessionId)) || Number(sessionId) <= 0) throw new Error("Session ID required for refund");
  const debit = await tx.creditDebit.findFirst({where: {userId: Number(userId), sessionId: Number(sessionId), reversedAt: null}});
  // Never guess a package for historical bookings without a recorded debit.
  if (!debit) return {ok: false, reason: "no_recorded_debit"};
  const claimed = await tx.creditDebit.updateMany({where: {id: debit.id, reversedAt: null}, data: {reversedAt: new Date()}});
  if (!claimed.count) return {ok: false, reason: "already_refunded"};
  const restored = await tx.userPackage.updateMany({where: {id: debit.userPackageId, sessionsUsed: {gt: 0}}, data: {sessionsUsed: {decrement: 1}}});
  if (restored.count !== 1) throw new Error("Credit ledger and package balance disagree");
  return {ok: true, packId: debit.userPackageId};
}
export async function refundOneCredit(userId, sessionId) {
  return prisma.$transaction(tx => refundOneCreditWithClient(tx, userId, sessionId));
}

/**
 * Auto-mark ended sessions as completed (lazy finalization) for a learner
 * This is called when a learner views their sessions.
 *
 * UPDATED: Credits are now consumed on BOOKING, not on completion.
 * This function only marks sessions as completed - no credit operations needed.
 */
const COMPLETION_GRACE_MIN = 2;

export async function finalizeExpiredSessionsForUser(userId) {
  const cutoff = new Date(Date.now() - COMPLETION_GRACE_MIN * 60 * 1000);
  const uid = Number(userId);

  const toFinalize = await prisma.session.findMany({
    where: {
      status: "scheduled", // Only finalize scheduled sessions
      OR: [
        { endAt: { lt: cutoff } },
        { AND: [{ endAt: null }, { startAt: { lt: cutoff } }] },
      ],
      AND: [
        {
          OR: [{ userId: uid }, { participants: { some: { userId: uid } } }],
        },
      ],
    },
    select: {
      id: true,
      userId: true,
      type: true,
      participants: { select: { userId: true, status: true } },
    },
    orderBy: { startAt: "asc" },
  });

  const results = [];

  for (const s of toFinalize) {
    try {
      await completeSessionAndQueueTeacherPayroll(s.id);

      // Credits are consumed on booking, not on completion
      // No credit operations needed here
      results.push({ sessionId: s.id, finalized: true });
    } catch (e) {
      logger.error(
        { err: e, sessionId: s.id },
        "[finalize] update failed for session"
      );
      results.push({ sessionId: s.id, finalized: false, error: e.message });
    }
  }

  return results;
}

/**
 * Same idea, but for teacher views
 *
 * UPDATED: Credits are now consumed on BOOKING, not on completion.
 * This function only marks sessions as completed - no credit operations needed.
 */
export async function finalizeExpiredSessionsForTeacher(teacherId) {
  const cutoff = new Date(Date.now() - COMPLETION_GRACE_MIN * 60 * 1000);
  const tid = Number(teacherId);

  const toFinalize = await prisma.session.findMany({
    where: {
      teacherId: tid,
      status: "scheduled", // Only finalize scheduled sessions
      OR: [
        { endAt: { lt: cutoff } },
        { AND: [{ endAt: null }, { startAt: { lt: cutoff } }] },
      ],
    },
    select: {
      id: true,
      userId: true,
      type: true,
      participants: { select: { userId: true, status: true } },
    },
    orderBy: { startAt: "asc" },
  });

  const results = [];

  for (const s of toFinalize) {
    try {
      await completeSessionAndQueueTeacherPayroll(s.id);

      // Credits are consumed on booking, not on completion
      // No credit operations needed here
      results.push({ sessionId: s.id, finalized: true });
    } catch (e) {
      logger.error(
        { err: e, sessionId: s.id },
        "[finalize-teacher] update failed"
      );
      results.push({ sessionId: s.id, finalized: false, error: e.message });
    }
  }

  return results;
}

/**
 * Get all active participants for a session (helper function)
 */
export async function getActiveParticipants(sessionId) {
  const session = await prisma.session.findUnique({
    where: { id: Number(sessionId) },
    select: {
      id: true,
      type: true,
      userId: true,
      participants: {
        where: { status: { not: "canceled" } },
        select: {
          userId: true,
          status: true,
          user: { select: { id: true, name: true, email: true } },
        },
      },
    },
  });

  if (!session) return [];

  if (session.type === "GROUP") {
    return session.participants.map((p) => ({
      userId: p.userId,
      status: p.status,
      ...p.user,
    }));
  }

  // ONE_ON_ONE: return legacy userId or first participant
  if (session.userId) {
    const user = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, name: true, email: true },
    });
    return user ? [{ userId: user.id, status: "booked", ...user }] : [];
  }

  if (session.participants.length) {
    const p = session.participants[0];
    return [{ userId: p.userId, status: p.status, ...p.user }];
  }

  return [];
}
