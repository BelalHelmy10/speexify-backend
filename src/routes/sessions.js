import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import {
  overlapsFilter,
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCredit,
  refundOneCredit,
  finalizeExpiredSessionsForUser,
  finalizeExpiredSessionsForTeacher,
} from "../services/sessionsService.js";
import { csrfMiddleware } from "../middleware/csrf.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Simple audit stub to avoid ReferenceError and keep logs
async function audit(userId, action, entity, entityId, meta = {}) {
  logger.info({ userId, action, entity, entityId, meta }, "audit event");
}

/* ========================================================================== */
/*                             SESSIONS (LESSONS)                             */
/* ========================================================================== */

router.get("/sessions/conflicts", requireAuth, async (req, res) => {
  const startParam = String(req.query.start || "");
  const endParam = req.query.end ? String(req.query.end) : null;

  const startAt = new Date(startParam);
  const endAt = endParam ? new Date(endParam) : null;

  if (Number.isNaN(startAt.getTime())) {
    return res.status(400).json({ error: "start is required (ISO datetime)" });
  }
  if (endParam && Number.isNaN(endAt.getTime())) {
    return res.status(400).json({ error: "end must be a valid ISO datetime" });
  }

  const userId = req.query.userId ? Number(req.query.userId) : null;
  const teacherId = req.query.teacherId ? Number(req.query.teacherId) : null;
  const excludeId = req.query.excludeId
    ? Number(req.query.excludeId)
    : undefined;

  try {
    const conflicts = await findSessionConflicts({
      startAt,
      endAt,
      userId,
      teacherId,
      excludeId,
    });
    res.json({ conflicts });
  } catch (e) {
    logger.error({ err: e }, "conflicts endpoint error");
    res.status(500).json({ error: "Failed to check conflicts" });
  }
});

router.get("/sessions", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;

    const sessions = await prisma.session.findMany({
      where: {
        participants: {
          some: { userId },
        },
      },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        participants: {
          select: {
            userId: true,
            status: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: { startAt: "asc" },
    });

    res.json(sessions);
  } catch (err) {
    logger.error({ err }, "GET /sessions failed");
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

router.get("/teacher/sessions", requireAuth, async (req, res) => {
  try {
    const teacherId = req.viewUserId;

    const sessions = await prisma.session.findMany({
      where: { teacherId },
      include: {
        // legacy 1:1 learner (may be null for group)
        user: { select: { id: true, email: true, name: true } },

        // group learners
        participants: {
          select: {
            userId: true,
            status: true,
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
      orderBy: { startAt: "asc" },
    });

    res.json(sessions);
  } catch (e) {
    logger.error({ err: e }, "GET /teacher/sessions failed");
    res.status(500).json({ error: "Failed to load teacher sessions" });
  }
});

/**
 * GET /api/sessions/:id
 * Returns full details for a single session (only to learner, teacher, or admin).
 */
router.get("/sessions/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        user: true, // legacy 1:1 learner (may be null)
        teacher: true,
        participants: {
          select: { userId: true, status: true },
        },
      },
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const viewerId = req.viewUserId;
    const isParticipant = session.participants.some(
      (p) => p.userId === viewerId
    );

    // Permission: learner participant OR teacher OR admin
    const isLearner = isParticipant || session.userId === viewerId;
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isLearner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const hasFeedback =
      !!session.teacherFeedbackMessageToLearner ||
      !!session.teacherFeedbackComments ||
      !!session.teacherFeedbackFutureSteps;

    const shaped = {
      ...session,
      isLearner,
      isTeacher,
      isAdmin,
      teacherFeedback: hasFeedback
        ? {
            messageToLearner: session.teacherFeedbackMessageToLearner || "",
            commentsOnSession: session.teacherFeedbackComments || "",
            futureSteps: session.teacherFeedbackFutureSteps || "",
          }
        : null,
    };

    return res.json({ session: shaped });
  } catch (err) {
    logger.error({ err }, "GET /sessions/:id failed");
    return res.status(500).json({ error: "Failed to load session" });
  }
});

// --------------------------------------------------------------------------
// GET /sessions/:id/feedback - Get detailed teacher feedback
// --------------------------------------------------------------------------
router.get("/sessions/:id/feedback", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const s = await prisma.session.findUnique({
      where: { id },
      include: {
        teacherFeedback: true,
      },
    });

    if (!s) return res.status(404).json({ error: "Session not found" });

    const isLearner = s.userId === req.user.id;
    const isTeacher = s.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isLearner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    res.json(s.teacherFeedback || null);
  } catch (e) {
    logger.error({ err: e }, "GET /sessions/:id/feedback error");
    res.status(500).json({ error: "Failed to load feedback" });
  }
});

// --------------------------------------------------------------------------
// POST /sessions/:id/feedback - Create/update detailed teacher feedback
// --------------------------------------------------------------------------
router.post("/sessions/:id/feedback", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const s = await prisma.session.findUnique({
      where: { id },
      select: { id: true, userId: true, teacherId: true, startAt: true },
    });

    if (!s) return res.status(404).json({ error: "Session not found" });

    // Only the teacher assigned to this session (or admin) can write feedback
    const isTeacher = s.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isTeacher || isAdmin)) {
      return res
        .status(403)
        .json({ error: "Only the teacher can give feedback" });
    }

    // Optional: only allow after the session has started
    const now = new Date();
    if (new Date(s.startAt) > now) {
      return res
        .status(400)
        .json({ error: "You can only leave feedback after the session" });
    }

    const messageToLearner = String(req.body?.messageToLearner || "").trim();
    const commentsOnSession = String(req.body?.commentsOnSession || "").trim();
    const futureSteps = String(req.body?.futureSteps || "").trim();

    const feedback = await prisma.sessionFeedback.upsert({
      where: { sessionId: s.id },
      update: {
        messageToLearner,
        commentsOnSession,
        futureSteps,
        teacherId: req.user.id,
      },
      create: {
        sessionId: s.id,
        teacherId: req.user.id,
        messageToLearner,
        commentsOnSession,
        futureSteps,
      },
    });

    res.json({ ok: true, feedback });
  } catch (e) {
    logger.error({ err: e }, "POST /sessions/:id/feedback error");
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

// POST /sessions/:id/feedback/teacher
router.post(
  "/sessions/:id/feedback/teacher",
  requireAuth,
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!id || Number.isNaN(id)) {
        return res.status(400).json({ error: "Invalid session id" });
      }

      const { messageToLearner, commentsOnSession, futureSteps } =
        req.body || {};

      const session = await prisma.session.findUnique({
        where: { id },
      });

      if (!session) {
        return res.status(404).json({ error: "Session not found" });
      }

      // Only the assigned teacher can edit feedback
      if (
        req.user.role !== "teacher" ||
        !session.teacherId ||
        session.teacherId !== req.user.id
      ) {
        return res
          .status(403)
          .json({ error: "Only the assigned teacher can update feedback" });
      }

      const updated = await prisma.session.update({
        where: { id },
        data: {
          teacherFeedbackMessageToLearner: messageToLearner || null,
          teacherFeedbackComments: commentsOnSession || null,
          teacherFeedbackFutureSteps: futureSteps || null,
        },
      });

      return res.json({ session: updated });
    } catch (err) {
      logger.error({ err }, "Teacher feedback save failed");
      return next(err); // your global error handler will send 500
    }
  }
);

// --------------------------------------------------------------------------
// POST /sessions/:id/attendance
// Teacher/Admin marks attendance per participant
// --------------------------------------------------------------------------
router.post("/sessions/:id/attendance", requireAuth, async (req, res) => {
  try {
    const sessionId = Number(req.params.id);
    if (!sessionId || Number.isNaN(sessionId)) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const { participants } = req.body || {};
    if (!Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: "participants[] is required" });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        startAt: true,
        teacherId: true,
        status: true,
        type: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (!session) return res.status(404).json({ error: "Session not found" });

    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = new Date();
    if (now < new Date(session.startAt)) {
      return res.status(400).json({
        error: "Cannot mark attendance before session starts",
      });
    }

    const allowedStatuses = new Set(["attended", "no_show", "excused"]);

    await prisma.$transaction(async (tx) => {
      for (const p of participants) {
        const uid = Number(p.userId);
        const status = String(p.status);

        if (!uid || !allowedStatuses.has(status)) continue;

        await tx.sessionParticipant.updateMany({
          where: {
            sessionId,
            userId: uid,
            status: { not: "canceled" },
          },
          data: {
            status,
            attendedAt: status === "attended" ? new Date() : null,
          },
        });
      }
    });

    return res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "mark attendance failed");
    return res.status(500).json({ error: "Failed to mark attendance" });
  }
});

router.post("/sessions/:id/complete", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const s = await prisma.session.findUnique({ where: { id } });
    if (!s) return res.status(404).json({ error: "Not found" });

    const canComplete =
      req.user.role === "admin" ||
      req.user.id === s.teacherId ||
      req.user.id === s.userId;

    if (!canComplete) return res.status(403).json({ error: "Forbidden" });

    if (s.status !== "completed") {
      await prisma.session.update({
        where: { id },
        data: { status: "completed" },
      });
      try {
        const full = await prisma.session.findUnique({
          where: { id: s.id },
          select: {
            id: true,
            type: true,
            userId: true,
            participants: { select: { userId: true, status: true } },
          },
        });

        if (full?.type === "GROUP") {
          const seats = (full.participants || [])
            .filter((p) => p.status === "attended")
            .map((p) => p.userId);

          for (const learnerId of seats) {
            try {
              await consumeOneCredit(learnerId);
            } catch (e) {
              logger.error(
                { err: e, userId: learnerId, sessionId: s.id },
                "consumeOneCredit failed during group complete"
              );
            }
          }
        } else {
          const learnerId =
            full?.userId ||
            (full?.participants && full.participants.length
              ? full.participants[0].userId
              : null);

          if (learnerId) {
            await consumeOneCredit(learnerId);
          }
        }
      } catch (e) {
        logger.error(
          { err: e, sessionId: s.id },
          "credit consumption failed during complete"
        );
      }
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "complete error");
    res.status(500).json({ error: "Failed to complete session" });
  }
});

router.post("/sessions/:id/cancel", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const sessionRow = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        startAt: true,
        userId: true,
        teacherId: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (!sessionRow) {
      return res.status(404).json({ error: "Session not found" });
    }

    const viewerId = req.viewUserId;
    const isAdmin = req.user.role === "admin";
    const isTeacher =
      !!sessionRow.teacherId && sessionRow.teacherId === req.user.id;

    const participant = (sessionRow.participants || []).find(
      (p) => p.userId === viewerId
    );
    const isLegacyOwner = sessionRow.userId === viewerId;
    const isLearner = !!participant || isLegacyOwner;

    if (!(isAdmin || isTeacher || isLearner)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const startsAt = new Date(sessionRow.startAt);
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const refundableByLearner =
      startsAt.getTime() - Date.now() >= twelveHoursMs;

    // ─────────────────────────────────────────────
    // GROUP: learner cancels ONLY their seat
    // ─────────────────────────────────────────────
    if (sessionRow.type === "GROUP" && isLearner && !isAdmin && !isTeacher) {
      // Mark this learner's participant row as canceled
      await prisma.sessionParticipant.updateMany({
        where: {
          sessionId: sessionRow.id,
          userId: viewerId,
        },
        data: { status: "canceled" },
      });

      // Refund only this learner if policy allows and session isn't completed
      if (refundableByLearner && sessionRow.status !== "completed") {
        try {
          const r = await refundOneCredit(viewerId);
          if (!r.ok) {
            logger.warn(
              { userId: viewerId, sessionId: sessionRow.id },
              "[credits] group seat cancel refund not applied (none to refund)"
            );
          }
        } catch (e) {
          logger.error(
            { err: e, userId: viewerId, sessionId: sessionRow.id },
            "[credits] group seat cancel refund failed"
          );
        }
      }

      return res.json({
        ok: true,
        scope: "participant",
        refunded: refundableByLearner && sessionRow.status !== "completed",
      });
    }

    // ─────────────────────────────────────────────
    // Otherwise: cancel the whole session (1:1 or group by teacher/admin)
    // ─────────────────────────────────────────────
    const updated = await prisma.session.update({
      where: { id: sessionRow.id },
      data: { status: "canceled" },
      select: {
        id: true,
        status: true,
        type: true,
      },
    });

    // Refund rules:
    // - Learner cancel: refund only if >=12h
    // - Teacher/Admin cancel: refund all seats if session not completed AND >=12h
    const refundableWholeSession =
      startsAt.getTime() - Date.now() >= twelveHoursMs &&
      sessionRow.status !== "completed";

    try {
      if (refundableWholeSession) {
        if (sessionRow.type === "GROUP") {
          const seats = (sessionRow.participants || [])
            .filter((p) => p.status !== "canceled")
            .map((p) => p.userId);

          for (const learnerId of seats) {
            try {
              const r = await refundOneCredit(learnerId);
              if (!r.ok) {
                logger.warn(
                  { userId: learnerId, sessionId: sessionRow.id },
                  "[credits] group cancel refund not applied (none to refund)"
                );
              }
            } catch (e) {
              logger.error(
                { err: e, userId: learnerId, sessionId: sessionRow.id },
                "[credits] group cancel refund failed"
              );
            }
          }
        } else {
          const learnerId =
            sessionRow.userId ||
            (sessionRow.participants && sessionRow.participants.length
              ? sessionRow.participants[0].userId
              : null);

          if (learnerId) {
            const r = await refundOneCredit(learnerId);
            if (!r.ok) {
              logger.warn(
                { userId: learnerId, sessionId: sessionRow.id },
                "[credits] cancel refund not applied (none to refund)"
              );
            }
          }
        }
      }
    } catch (e) {
      logger.error(
        { err: e, sessionId: sessionRow.id },
        "[credits] cancel refund failed"
      );
    }

    return res.json({
      ok: true,
      scope: "session",
      refunded: refundableWholeSession,
      session: updated,
    });
  } catch (e) {
    logger.error({ err: e }, "Cancel failed");
    res.status(400).json({ error: "Failed to cancel session" });
  }
});

router.post("/sessions/:id/reschedule", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { startAt, endAt } = req.body;

    if (!startAt) return res.status(400).json({ error: "startAt is required" });

    const s = await prisma.session.findUnique({
      where: { id },
      select: { id: true, userId: true, teacherId: true, status: true },
    });
    if (!s) return res.status(404).json({ error: "Not found" });

    const isOwner = s.userId === req.user.id;
    const isTeacher = s.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isOwner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const conflicts = await findSessionConflicts({
      startAt: new Date(startAt),
      endAt: endAt ? new Date(endAt) : null,
      userId: s.userId,
      teacherId: s.teacherId,
      excludeId: id,
    });
    if (conflicts.length) {
      return res.status(409).json({ error: "Time conflict", conflicts });
    }

    const updated = await prisma.session.update({
      where: { id },
      data: {
        startAt: new Date(startAt),
        endAt: endAt ? new Date(endAt) : null,
        status: "scheduled",
      },
    });

    res.json({ ok: true, session: updated });
  } catch (e) {
    logger.error({ err: e }, "reschedule error");
    res.status(400).json({ error: "Failed to reschedule session" });
  }
});

router.get("/me/sessions", requireAuth, async (req, res) => {
  try {
    // Best-effort finalization, don't break if it fails
    try {
      await finalizeExpiredSessionsForUser(req.viewUserId);
    } catch (e) {
      logger.error(
        { err: e, userId: req.viewUserId },
        "finalizeExpiredSessionsForUser failed"
      );
    }

    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { range = "upcoming", limit = 10 } = req.query;
    const now = new Date();

    // membership base: learner sees sessions they participate in
    // teacher sees sessions they teach OR sessions they participate in (keeps your old behavior)
    const whereBase =
      role === "teacher"
        ? {
            OR: [
              { teacherId: userId },
              { participants: { some: { userId } } },
              { userId }, // legacy fallback
            ],
          }
        : {
            OR: [
              { participants: { some: { userId } } },
              { userId }, // legacy fallback
            ],
          };

    const notCanceled = { status: { not: "canceled" } };

    const inProgressOrFuture = {
      OR: [
        { startAt: { gte: now } },
        {
          AND: [
            { startAt: { lte: now } },
            { OR: [{ endAt: { gte: now } }, { endAt: null }] },
          ],
        },
      ],
    };

    const pastCondition = {
      OR: [
        { endAt: { lt: now } },
        { AND: [{ endAt: null }, { startAt: { lt: now } }] },
      ],
    };

    const where =
      range === "past"
        ? { AND: [whereBase, pastCondition] }
        : { AND: [whereBase, notCanceled, inProgressOrFuture] };

    const orderBy = range === "past" ? { startAt: "desc" } : { startAt: "asc" };

    const rawSessions = await prisma.session.findMany({
      where,
      orderBy,
      take: Number(limit) || 10,
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        joinUrl: true,
        status: true,
        type: true,
        capacity: true,
        teacherId: true,
        teacher: { select: { id: true, name: true, email: true } },
        participants: {
          select: {
            userId: true,
            status: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
        teacherFeedbackMessageToLearner: true,
        teacherFeedbackComments: true,
        teacherFeedbackFutureSteps: true,
      },
    });

    const sessions = rawSessions.map((s) => {
      const hasFeedback =
        !!s.teacherFeedbackMessageToLearner ||
        !!s.teacherFeedbackComments ||
        !!s.teacherFeedbackFutureSteps;

      const teacherFeedback = hasFeedback
        ? {
            messageToLearner: s.teacherFeedbackMessageToLearner || "",
            commentsOnSession: s.teacherFeedbackComments || "",
            futureSteps: s.teacherFeedbackFutureSteps || "",
          }
        : null;

      const {
        teacherFeedbackMessageToLearner,
        teacherFeedbackComments,
        teacherFeedbackFutureSteps,
        ...rest
      } = s;

      const participantCount = Array.isArray(rest.participants)
        ? rest.participants.filter((p) => p.status !== "canceled").length
        : 0;

      return {
        ...rest,
        participantCount,
        teacherFeedback,
      };
    });

    res.json(sessions);
  } catch (e) {
    logger.error({ err: e }, "GET /me/sessions failed");
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

router.get("/me/sessions-between", requireAuth, async (req, res) => {
  try {
    const startParam = String(req.query.start || "");
    const endParam = String(req.query.end || "");
    const includeCanceled = String(req.query.includeCanceled || "") === "true";

    const startAt = new Date(startParam);
    const endAt = new Date(endParam);

    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      return res.status(400).json({ error: "Invalid date range" });
    }

    const userId = req.viewUserId;
    const role = req.user.role || "learner";

    const whereBase =
      role === "teacher"
        ? {
            OR: [
              { teacherId: userId },
              { participants: { some: { userId } } },
              { userId }, // legacy
            ],
          }
        : {
            OR: [{ participants: { some: { userId } } }, { userId }],
          };

    const where = {
      AND: [
        whereBase,
        includeCanceled ? {} : { status: { not: "canceled" } },
        { startAt: { lte: endAt } },
        { OR: [{ endAt: { gte: startAt } }, { endAt: null }] },
      ],
    };

    const sessions = await prisma.session.findMany({
      where,
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        joinUrl: true,
        status: true,
        type: true,
        capacity: true,
        feedback: { select: { id: true } },
      },
    });

    const shaped = sessions.map((s) => ({
      ...s,
      teacherFeedback: s.feedback,
    }));

    return res.json({ sessions: shaped });
  } catch (e) {
    logger.error({ err: e }, "GET /me/sessions-between failed");
    return res.status(500).json({
      error: e?.message || e?.meta?.cause || "Failed to load calendar sessions",
    });
  }
});

// GET /api/me/progress
// Learner progress summary + simple monthly timeline
router.get("/me/progress", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId || req.user.id;

    const completedSessions = await prisma.session.findMany({
      where: {
        status: "completed",
        OR: [
          { participants: { some: { userId } } },
          { userId }, // legacy
        ],
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        startAt: true,
        endAt: true,
      },
    });

    const totalCompletedSessions = completedSessions.length;

    let totalMinutes = 0;
    const monthCounts = new Map();

    for (const s of completedSessions) {
      const start = s.startAt ? new Date(s.startAt) : null;
      const end = s.endAt ? new Date(s.endAt) : null;

      if (
        start &&
        end &&
        !Number.isNaN(start.getTime()) &&
        !Number.isNaN(end.getTime())
      ) {
        const diffMs = end.getTime() - start.getTime();
        if (diffMs > 0) {
          totalMinutes += diffMs / 1000 / 60;
        }
      }

      if (start && !Number.isNaN(start.getTime())) {
        const year = start.getFullYear();
        const month = String(start.getMonth() + 1).padStart(2, "0");
        const key = `${year}-${month}`;
        monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
      }
    }

    const totalHours = Number((totalMinutes / 60).toFixed(1));

    const timeline = Array.from(monthCounts.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
      .slice(-12);

    return res.json({
      summary: {
        totalCompletedSessions,
        totalMinutes: Math.round(totalMinutes),
        totalHours,
        averageRating: null,
      },
      timeline,
    });
  } catch (err) {
    logger.error({ err }, "GET /me/progress failed");
    // send the real message to help debug if it ever breaks again
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load progress" });
  }
});

/* ========================================================================== */
/*                               ADMIN: SESSIONS                              */
/* ========================================================================== */

router.get("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      q = "",
      userId = "",
      teacherId = "",
      range = "",
      limit = "100",
      offset = "0",
    } = req.query;

    const now = new Date();
    const where = {
      ...(userId ? { userId: Number(userId) } : {}),
      ...(teacherId ? { teacherId: Number(teacherId) } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { joinUrl: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    if (range === "upcoming") {
      where.AND = [
        ...(where.AND || []),
        { startAt: { gte: now } },
        { status: { not: "canceled" } },
      ];
    } else if (range === "past") {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { endAt: { lt: now } },
            { AND: [{ endAt: null }, { startAt: { lt: now } }] },
          ],
        },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.session.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ startAt: "desc" }, { id: "desc" }],
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.session.count({ where }),
    ]);

    res.json({ items, total });
  } catch (err) {
    logger.error({ err }, "admin.sessions.list error");
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

router.post("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      type = "ONE_ON_ONE",
      learnerId,
      learnerIds,
      teacherId,
      capacity,
      title = "Lesson",
      startAt,
      durationMin,
      endAt,
      meetingUrl,
      allowNoCredit = false,
    } = req.body;

    if (!startAt) {
      return res.status(400).json({ error: "startAt is required" });
    }

    const start = new Date(startAt);
    if (Number.isNaN(start.getTime())) {
      return res.status(400).json({ error: "Invalid startAt datetime" });
    }

    const finalEndAt = endAt
      ? new Date(endAt)
      : new Date(start.getTime() + Number(durationMin || 60) * 60_000);

    if (type === "ONE_ON_ONE") {
      if (!learnerId) {
        return res.status(400).json({ error: "learnerId is required" });
      }

      // conflict check
      const conflicts = await findSessionConflicts({
        startAt: start,
        endAt: finalEndAt,
        userId: learnerId,
        teacherId,
      });

      if (conflicts.length) {
        return res.status(409).json({ error: "Time conflict", conflicts });
      }

      // credit check
      const remaining = await getRemainingCredits(learnerId);
      if (!allowNoCredit && remaining <= 0) {
        return res.status(422).json({
          error: "no_credits",
          message: "Learner has no remaining credits",
        });
      }

      const session = await prisma.session.create({
        data: {
          type: "ONE_ON_ONE",
          userId: learnerId,
          teacherId,
          title,
          startAt: start,
          endAt: finalEndAt,
          joinUrl: meetingUrl || null,
        },
      });

      await prisma.sessionParticipant.create({
        data: {
          sessionId: session.id,
          userId: learnerId,
        },
      });

      return res.status(201).json({ ok: true, session });
    }

    // ─────────────────────────────────────────────
    // GROUP SESSION
    // ─────────────────────────────────────────────

    if (!Array.isArray(learnerIds) || learnerIds.length === 0) {
      return res
        .status(400)
        .json({ error: "learnerIds[] is required for GROUP sessions" });
    }

    if (capacity && learnerIds.length > capacity) {
      return res.status(400).json({
        error: "capacity_exceeded",
        message: "learnerIds exceed session capacity",
      });
    }

    // conflict + credit checks PER learner
    for (const uid of learnerIds) {
      const conflicts = await findSessionConflicts({
        startAt: start,
        endAt: finalEndAt,
        userId: uid,
        teacherId,
      });

      if (conflicts.length) {
        return res.status(409).json({
          error: "Time conflict",
          learnerId: uid,
          conflicts,
        });
      }

      const remaining = await getRemainingCredits(uid);
      if (!allowNoCredit && remaining <= 0) {
        return res.status(422).json({
          error: "no_credits",
          learnerId: uid,
        });
      }
    }

    const session = await prisma.session.create({
      data: {
        type: "GROUP",
        capacity: capacity || null,
        teacherId,
        title,
        startAt: start,
        endAt: finalEndAt,
        joinUrl: meetingUrl || null,
      },
    });

    await prisma.sessionParticipant.createMany({
      data: learnerIds.map((uid) => ({
        sessionId: session.id,
        userId: uid,
      })),
      skipDuplicates: true,
    });

    return res.status(201).json({ ok: true, session });
  } catch (e) {
    logger.error({ err: e }, "admin.createSession error");
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// --------------------------------------------------------------------------
// ADMIN: Add participant(s) to an existing GROUP session
// POST /api/admin/sessions/:id/participants
// body: { userId?: number, userIds?: number[], allowNoCredit?: boolean, allowOverCapacity?: boolean }
// --------------------------------------------------------------------------
router.post(
  "/admin/sessions/:id/participants",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const sessionId = Number(req.params.id);
      if (!sessionId || Number.isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session id" });
      }

      const {
        userId,
        userIds,
        allowNoCredit = false,
        allowOverCapacity = false,
      } = req.body || {};

      const idsRaw = Array.isArray(userIds) ? userIds : userId ? [userId] : [];
      const ids = idsRaw
        .map((x) => Number(x))
        .filter((x) => x && !Number.isNaN(x));

      if (!ids.length) {
        return res.status(400).json({ error: "Provide userId or userIds[]" });
      }

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          type: true,
          status: true,
          capacity: true,
          startAt: true,
          endAt: true,
          teacherId: true,
          participants: { select: { userId: true, status: true } },
        },
      });

      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.type !== "GROUP") {
        return res.status(400).json({
          error: "Only GROUP sessions support participants management",
        });
      }
      if (session.status === "canceled") {
        return res
          .status(400)
          .json({ error: "Cannot add participants to a canceled session" });
      }
      if (session.status === "completed") {
        return res
          .status(400)
          .json({ error: "Cannot add participants to a completed session" });
      }

      const existing = new Map(
        (session.participants || []).map((p) => [p.userId, p.status])
      );

      // Deduplicate + remove already-active participants
      const toAdd = ids.filter((uid) => {
        const st = existing.get(uid);
        return !st || st === "canceled";
      });

      if (!toAdd.length) {
        return res.json({ ok: true, added: 0, alreadyInSession: ids });
      }

      // Capacity check (count non-canceled)
      const activeCount = (session.participants || []).filter(
        (p) => p.status !== "canceled"
      ).length;
      const nextCount = activeCount + toAdd.length;

      if (
        !allowOverCapacity &&
        session.capacity &&
        nextCount > session.capacity
      ) {
        return res.status(400).json({
          error: "capacity_exceeded",
          message: "Adding these learners exceeds session capacity",
          capacity: session.capacity,
          activeCount,
          attemptingToAdd: toAdd.length,
        });
      }

      // Validate each learner: exists + enabled + conflicts + credits
      const startAt = new Date(session.startAt);
      const endAt = session.endAt ? new Date(session.endAt) : null;

      for (const uid of toAdd) {
        const u = await prisma.user.findUnique({
          where: { id: uid },
          select: { id: true, role: true, isDisabled: true },
        });
        if (!u || u.isDisabled) {
          return res
            .status(404)
            .json({ error: "User not found or disabled", userId: uid });
        }
        if (u.role !== "learner" && u.role !== "admin") {
          return res
            .status(400)
            .json({ error: "userId must refer to a learner", userId: uid });
        }

        const conflicts = await findSessionConflicts({
          startAt,
          endAt,
          userId: uid,
          teacherId: session.teacherId || undefined,
        });
        if (conflicts.length) {
          return res
            .status(409)
            .json({ error: "Time conflict", userId: uid, conflicts });
        }

        const remaining = await getRemainingCredits(uid);
        if (!allowNoCredit && remaining <= 0) {
          return res.status(422).json({
            error: "no_credits",
            userId: uid,
            message: "Learner has no remaining credits",
          });
        }
      }

      // Insert/update participant rows
      // If participant existed but was canceled, revive it. Otherwise create.
      await prisma.$transaction(async (tx) => {
        for (const uid of toAdd) {
          const existedStatus = existing.get(uid);
          if (existedStatus === "canceled") {
            await tx.sessionParticipant.updateMany({
              where: { sessionId, userId: uid },
              data: { status: "booked" },
            });
          } else {
            await tx.sessionParticipant.create({
              data: { sessionId, userId: uid, status: "booked" },
            });
          }
        }
      });

      return res
        .status(201)
        .json({ ok: true, added: toAdd.length, userIds: toAdd });
    } catch (e) {
      logger.error({ err: e }, "admin.sessions.addParticipants error");
      return res.status(500).json({ error: "Failed to add participants" });
    }
  }
);

// --------------------------------------------------------------------------
// ADMIN: Remove a participant from a GROUP session (cancel seat)
// DELETE /api/admin/sessions/:id/participants/:userId?refund=1
// - We cancel the participant row (do NOT delete) for audit/history.
// - Refund rules: only if session not completed AND start is >= 12h away,
//   and refund=1 is passed (so admin explicitly chooses refund).
// --------------------------------------------------------------------------
router.delete(
  "/admin/sessions/:id/participants/:userId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const sessionId = Number(req.params.id);
      const targetUserId = Number(req.params.userId);
      const refund = String(req.query.refund || "") === "1";

      if (!sessionId || Number.isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session id" });
      }
      if (!targetUserId || Number.isNaN(targetUserId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          type: true,
          status: true,
          startAt: true,
          participants: { select: { userId: true, status: true } },
        },
      });

      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.type !== "GROUP") {
        return res.status(400).json({
          error: "Only GROUP sessions support participants management",
        });
      }

      const row = (session.participants || []).find(
        (p) => p.userId === targetUserId
      );
      if (!row)
        return res
          .status(404)
          .json({ error: "Participant not found in session" });

      if (row.status === "canceled") {
        return res.json({
          ok: true,
          removed: true,
          alreadyCanceled: true,
          refunded: false,
        });
      }

      await prisma.sessionParticipant.updateMany({
        where: { sessionId, userId: targetUserId },
        data: { status: "canceled" },
      });

      let refunded = false;

      if (refund && session.status !== "completed") {
        const startsAt = new Date(session.startAt);
        const twelveHoursMs = 12 * 60 * 60 * 1000;
        const refundable = startsAt.getTime() - Date.now() >= twelveHoursMs;

        if (refundable) {
          try {
            const r = await refundOneCredit(targetUserId);
            refunded = !!r.ok;
            if (!r.ok) {
              logger.warn(
                { userId: targetUserId, sessionId },
                "[credits] admin remove seat refund not applied (none to refund)"
              );
            }
          } catch (e) {
            logger.error(
              { err: e, userId: targetUserId, sessionId },
              "[credits] admin remove seat refund failed"
            );
          }
        }
      }

      return res.json({ ok: true, removed: true, refunded });
    } catch (e) {
      logger.error({ err: e }, "admin.sessions.removeParticipant error");
      return res.status(500).json({ error: "Failed to remove participant" });
    }
  }
);

router.patch(
  "/admin/sessions/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await prisma.session.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Not found" });

      const patch = {};
      const allowed = [
        "title",
        "joinUrl",
        "status",
        "startAt",
        "endAt",
        "userId",
        "teacherId",
      ];
      for (const k of allowed) {
        if (req.body[k] !== undefined) patch[k] = req.body[k];
      }

      const start = patch.startAt ? new Date(patch.startAt) : existing.startAt;
      const end = patch.endAt ? new Date(patch.endAt) : existing.endAt;
      const userId = patch.userId ? Number(patch.userId) : existing.userId;
      const teacherId = patch.teacherId
        ? Number(patch.teacherId)
        : existing.teacherId;

      if (patch.startAt || patch.endAt || patch.userId || patch.teacherId) {
        const conflicts = await findSessionConflicts({
          startAt: start,
          endAt: end,
          userId,
          teacherId,
          excludeId: id,
        });
        if (conflicts.length) {
          return res.status(409).json({ error: "Time conflict", conflicts });
        }
      }

      if (patch.userId !== undefined) patch.userId = Number(patch.userId);
      if (patch.teacherId !== undefined)
        patch.teacherId = Number(patch.teacherId);
      if (patch.startAt !== undefined) patch.startAt = new Date(patch.startAt);
      if (patch.endAt !== undefined)
        patch.endAt = patch.endAt ? new Date(patch.endAt) : null;

      const prevStatus = existing.status;
      const nextStatus = patch.status ?? existing.status;

      let shouldConsume = false;
      let shouldRefund = false;

      if (prevStatus !== "completed" && nextStatus === "completed") {
        shouldConsume = true;
      } else if (prevStatus === "completed" && nextStatus !== "completed") {
        shouldRefund = true;
      }

      const updated = await prisma.session.update({
        where: { id },
        data: patch,
        include: {
          user: { select: { id: true, name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
        },
      });

      try {
        if (shouldConsume || shouldRefund) {
          const full = await prisma.session.findUnique({
            where: { id: updated.id },
            select: {
              id: true,
              type: true,
              userId: true,
              participants: { select: { userId: true, status: true } },
            },
          });

          if (full?.type === "GROUP") {
            const seats = (full.participants || [])
              .filter((p) => p.status !== "canceled")
              .map((p) => p.userId);

            for (const learnerId of seats) {
              try {
                if (shouldConsume) {
                  const resUse = await consumeOneCredit(learnerId);
                  if (!resUse.ok) {
                    logger.warn(
                      { userId: learnerId, sessionId: updated.id },
                      "[credits] No active credits to consume for user (group)"
                    );
                  }
                } else if (shouldRefund) {
                  const resRef = await refundOneCredit(learnerId);
                  if (!resRef.ok) {
                    logger.warn(
                      { userId: learnerId, sessionId: updated.id },
                      "[credits] Nothing to refund for user (group)"
                    );
                  }
                }
              } catch (e) {
                logger.error(
                  { err: e, userId: learnerId, sessionId: updated.id },
                  "[credits] group accounting failure"
                );
              }
            }
          } else {
            const learnerId =
              full?.userId ||
              (full?.participants && full.participants.length
                ? full.participants[0].userId
                : null);

            if (learnerId) {
              if (shouldConsume) {
                const resUse = await consumeOneCredit(learnerId);
                if (!resUse.ok) {
                  logger.warn(
                    { userId: learnerId, sessionId: updated.id },
                    "[credits] No active credits to consume for user"
                  );
                }
              } else if (shouldRefund) {
                const resRef = await refundOneCredit(learnerId);
                if (!resRef.ok) {
                  logger.warn(
                    { userId: learnerId, sessionId: updated.id },
                    "[credits] Nothing to refund for user"
                  );
                }
              }
            }
          }
        }
      } catch (e) {
        logger.error(
          { err: e, sessionId: updated.id },
          "[credits] accounting failure"
        );
      }

      await audit(req.user.id, "session_update", "Session", id, patch);
      res.json(updated);
    } catch (err) {
      logger.error({ err }, "admin.sessions.patch error");
      res.status(500).json({ error: "Failed to update session" });
    }
  }
);

router.delete(
  "/admin/sessions/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.session.delete({ where: { id } });
      await audit(req.user.id, "session_delete", "Session", id);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "admin.sessions.delete error");
      res.status(500).json({ error: "Failed to delete session" });
    }
  }
);

export default router;
