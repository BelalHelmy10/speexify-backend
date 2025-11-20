// src/services/sessionsService.js
import { PrismaClient } from "@prisma/client";
import { logger } from "../lib/logger.js";

const prisma = new PrismaClient();

// Re-used in many places to check time overlaps
export function overlapsFilter(startAt, endAt) {
  const end = endAt ? new Date(endAt) : new Date("2999-12-31");
  return {
    startAt: { lt: end },
    OR: [{ endAt: { gt: new Date(startAt) } }, { endAt: null }],
  };
}

// Find conflicting sessions for learner / teacher
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
  if (userId) clauses.push({ ...whereCommon, userId });
  if (teacherId) clauses.push({ ...whereCommon, teacherId });
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
    },
    orderBy: { startAt: "asc" },
  });
}

// How many total remaining credits does a user have right now?
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

// Take 1 credit from the newest active pack that still has remaining credits.
export async function consumeOneCredit(userId) {
  const pack = await prisma.userPackage.findFirst({
    where: {
      userId: Number(userId),
      status: "active",
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      sessionsUsed: { lt: prisma.userPackage.fields.sessionsTotal },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  if (!pack) return { ok: false };

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

// Give back 1 credit to the newest pack that has at least 1 used.
export async function refundOneCredit(userId) {
  const pack = await prisma.userPackage.findFirst({
    where: {
      userId: Number(userId),
      status: "active",
      sessionsUsed: { gt: 0 },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });

  if (!pack) return { ok: false };

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

// Auto-mark ended sessions as completed (lazy finalization) for a learner
const COMPLETION_GRACE_MIN = 2;

export async function finalizeExpiredSessionsForUser(userId) {
  const cutoff = new Date(Date.now() - COMPLETION_GRACE_MIN * 60 * 1000);

  const toFinalize = await prisma.session.findMany({
    where: {
      userId: Number(userId),
      status: { not: "canceled" },
      NOT: { status: "completed" },
      OR: [
        { endAt: { lt: cutoff } },
        { AND: [{ endAt: null }, { startAt: { lt: cutoff } }] },
      ],
    },
    select: { id: true, userId: true },
    orderBy: { startAt: "asc" },
  });

  for (const s of toFinalize) {
    try {
      await prisma.session.update({
        where: { id: s.id },
        data: { status: "completed" },
      });
      try {
        await consumeOneCredit(s.userId);
      } catch (e) {
        logger.error(
          { err: e, sessionId: s.id },
          "[finalize] credit consume failed for session"
        );
      }
    } catch (e) {
      logger.error(
        { err: e, sessionId: s.id },
        "[finalize] update failed for session"
      );
    }
  }
}

// Same idea, but for teacher views
export async function finalizeExpiredSessionsForTeacher(teacherId) {
  const cutoff = new Date(Date.now() - COMPLETION_GRACE_MIN * 60 * 1000);

  const toFinalize = await prisma.session.findMany({
    where: {
      teacherId: Number(teacherId),
      status: { not: "canceled" },
      NOT: { status: "completed" },
      OR: [
        { endAt: { lt: cutoff } },
        { AND: [{ endAt: null }, { startAt: { lt: cutoff } }] },
      ],
    },
    select: { id: true, userId: true },
    orderBy: { startAt: "asc" },
  });

  for (const s of toFinalize) {
    try {
      await prisma.session.update({
        where: { id: s.id },
        data: { status: "completed" },
      });
      try {
        await consumeOneCredit(s.userId);
      } catch (e) {
        logger.error(
          { err: e, sessionId: s.id },
          "[finalize-teacher] credit consume failed"
        );
      }
    } catch (e) {
      logger.error(
        { err: e, sessionId: s.id },
        "[finalize-teacher] update failed"
      );
    }
  }
}
