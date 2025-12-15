// src/services/sessionsService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";

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
export async function findSessionConflicts({
  startAt,
  endAt,
  userId,
  teacherId,
  excludeId,
}) {
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

  return prisma.session.findMany({
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

/**
 * How many total remaining credits does a user have right now?
 */
export async function getRemainingCredits(userId) {
  const packs = await prisma.userPackage.findMany({
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
 */
export async function consumeOneCredit(userId) {
  // Find a pack with remaining credits
  const packs = await prisma.userPackage.findMany({
    where: {
      userId: Number(userId),
      status: "active",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  // Find the first pack with remaining credits
  const pack = packs.find(
    (p) => Number(p.sessionsTotal) - Number(p.sessionsUsed || 0) > 0
  );

  if (!pack) {
    return { ok: false, reason: "no_credits" };
  }

  const updated = await prisma.userPackage.update({
    where: { id: pack.id },
    data: { sessionsUsed: { increment: 1 } },
  });

  return {
    ok: true,
    packId: pack.id,
    remaining: updated.sessionsTotal - updated.sessionsUsed,
  };
}

/**
 * Give back 1 credit to the newest pack that has at least 1 used.
 */
export async function refundOneCredit(userId) {
  const pack = await prisma.userPackage.findFirst({
    where: {
      userId: Number(userId),
      status: "active",
      sessionsUsed: { gt: 0 },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  if (!pack) {
    return { ok: false, reason: "nothing_to_refund" };
  }

  const updated = await prisma.userPackage.update({
    where: { id: pack.id },
    data: { sessionsUsed: { decrement: 1 } },
  });

  return {
    ok: true,
    packId: pack.id,
    remaining: updated.sessionsTotal - updated.sessionsUsed,
  };
}

/**
 * Auto-mark ended sessions as completed (lazy finalization) for a learner
 * This is called when a learner views their sessions.
 *
 * UNIFIED CREDIT LOGIC:
 * - Credits are consumed for ALL non-canceled participants
 * - This matches the behavior in /complete and admin PATCH
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
      await prisma.session.update({
        where: { id: s.id },
        data: { status: "completed" },
      });

      const creditResults = [];

      // UNIFIED: Consume credits for all non-canceled participants
      if (s.type === "GROUP") {
        const activeSeats = (s.participants || [])
          .filter((p) => p.status !== "canceled")
          .map((p) => p.userId);

        for (const learnerId of activeSeats) {
          try {
            const result = await consumeOneCredit(learnerId);
            creditResults.push({ learnerId, consumed: result.ok });
          } catch (e) {
            logger.error(
              { err: e, sessionId: s.id, userId: learnerId },
              "[finalize] group credit consume failed"
            );
            creditResults.push({ learnerId, consumed: false });
          }
        }
      } else {
        // ONE_ON_ONE: legacy userId OR first participant
        const learnerId =
          s.userId ||
          (s.participants && s.participants.length
            ? s.participants[0].userId
            : null);

        if (learnerId) {
          try {
            const result = await consumeOneCredit(learnerId);
            creditResults.push({ learnerId, consumed: result.ok });
          } catch (e) {
            logger.error(
              { err: e, sessionId: s.id, userId: learnerId },
              "[finalize] credit consume failed"
            );
            creditResults.push({ learnerId, consumed: false });
          }
        }
      }

      results.push({ sessionId: s.id, finalized: true, creditResults });
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
      await prisma.session.update({
        where: { id: s.id },
        data: { status: "completed" },
      });

      const creditResults = [];

      // UNIFIED: Consume credits for all non-canceled participants
      if (s.type === "GROUP") {
        const activeSeats = (s.participants || [])
          .filter((p) => p.status !== "canceled")
          .map((p) => p.userId);

        for (const learnerId of activeSeats) {
          try {
            const result = await consumeOneCredit(learnerId);
            creditResults.push({ learnerId, consumed: result.ok });
          } catch (e) {
            logger.error(
              { err: e, sessionId: s.id, userId: learnerId },
              "[finalize-teacher] group credit consume failed"
            );
            creditResults.push({ learnerId, consumed: false });
          }
        }
      } else {
        const learnerId =
          s.userId ||
          (s.participants && s.participants.length
            ? s.participants[0].userId
            : null);

        if (learnerId) {
          try {
            const result = await consumeOneCredit(learnerId);
            creditResults.push({ learnerId, consumed: result.ok });
          } catch (e) {
            logger.error(
              { err: e, sessionId: s.id, userId: learnerId },
              "[finalize-teacher] credit consume failed"
            );
            creditResults.push({ learnerId, consumed: false });
          }
        }
      }

      results.push({ sessionId: s.id, finalized: true, creditResults });
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
