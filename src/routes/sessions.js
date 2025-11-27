import { Router } from "express";
import { PrismaClient } from "@prisma/client";
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
const prisma = new PrismaClient();

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
    const sessions = await prisma.session.findMany({
      where: { userId: req.viewUserId },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
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
    const sessions = await prisma.session.findMany({
      where: { teacherId: req.viewUserId },
      include: {
        user: { select: { id: true, email: true, name: true } },
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
        user: true,
        teacher: true,
      },
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Permission: learner, teacher or admin
    const isLearner = session.userId === req.user.id;
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isLearner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const hasFeedback =
      !!session.teacherFeedbackMessageToLearner ||
      !!session.teacherFeedbackComments ||
      !!session.teacherFeedbackFutureSteps;

    // ⭐ NEW: include isLearner / isTeacher / isAdmin flags for the frontend
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
        await consumeOneCredit(s.userId);
      } catch (e) {
        logger.error(
          { err: e, userId: s.userId, sessionId: s.id },
          "consumeOneCredit failed during complete"
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
    const sessionRow = await prisma.session.findUnique({ where: { id } });
    if (!sessionRow)
      return res.status(404).json({ error: "Session not found" });

    const isOwner = sessionRow.userId === req.user.id;
    const isTeacher = sessionRow.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isOwner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Simple policy: refund if user cancels >= 12h before start
    const startsAt = new Date(sessionRow.startAt);
    const twelveHoursMs = 12 * 60 * 60 * 1000;
    const eligibleForRefund =
      isOwner && startsAt.getTime() - Date.now() >= twelveHoursMs;

    const updated = await prisma.session.update({
      where: { id },
      data: { status: "canceled" },
    });

    try {
      if (eligibleForRefund) {
        const r = await refundOneCredit(sessionRow.userId);
        if (!r.ok) {
          logger.warn(
            { userId: sessionRow.userId, sessionId: sessionRow.id },
            "[credits] cancel refund not applied (none to refund)"
          );
        }
      }
    } catch (e) {
      logger.error(
        { err: e, userId: sessionRow.userId, sessionId: sessionRow.id },
        "[credits] cancel refund failed"
      );
    }

    res.json({ ok: true, session: updated });
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

// GET current classroom state
router.get("/sessions/:id/classroom-state", async (req, res) => {
  const id = Number(req.params.id);
  const session = await prisma.session.findUnique({ where: { id } });

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json({
    classroomState: session.classroomState || {},
  });
});

// POST (update) classroom state
router.post("/sessions/:id/classroom-state", async (req, res) => {
  const id = Number(req.params.id);
  const { classroomState } = req.body; // expect a plain object

  const session = await prisma.session.update({
    where: { id },
    data: {
      classroomState,
    },
  });

  res.json({
    classroomState: session.classroomState || {},
  });
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

    // base filter: learner vs teacher
    const whereBase =
      role === "teacher"
        ? { OR: [{ userId }, { teacherId: userId }] }
        : { userId };

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

    // 1) Fetch raw sessions including the three feedback columns
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
        teacherFeedbackMessageToLearner: true,
        teacherFeedbackComments: true,
        teacherFeedbackFutureSteps: true,
      },
    });

    // 2) Shape the feedback columns into a teacherFeedback object
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

      return {
        ...rest,
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

    // base filter: learner vs teacher
    const whereBase =
      role === "teacher"
        ? { OR: [{ userId }, { teacherId: userId }] }
        : { userId };

    // build the full Prisma "where" object here
    const where = {
      AND: [
        whereBase,
        includeCanceled ? {} : { status: { not: "canceled" } },
        // events that overlap with the [startAt, endAt] window
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
        // use the real relation name from Prisma
        feedback: { select: { id: true } },
      },
    });

    // shape for the frontend: keep teacherFeedback key
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
        userId,
        status: "completed",
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
    const learnerId = Number(req.body.learnerId ?? req.body.userId);
    const teacherId = Number(req.body.tutorId ?? req.body.teacherId);

    const startStr = String(req.body.start ?? req.body.startAt ?? "");
    const startAt = new Date(startStr);

    const durationMin =
      req.body.durationMin !== undefined && req.body.durationMin !== null
        ? Number(req.body.durationMin)
        : null;

    const endAtStr =
      req.body.endAt !== undefined && req.body.endAt !== null
        ? String(req.body.endAt)
        : null;
    const endAt = endAtStr ? new Date(endAtStr) : null;

    const title = (req.body.title ?? "").toString().trim() || "Lesson";
    const meetingUrl = (req.body.meetingUrl ?? "").toString().trim() || null;

    if (!learnerId)
      return res.status(400).json({ error: "learnerId/userId is required" });

    if (!startStr || Number.isNaN(startAt.getTime()))
      return res
        .status(400)
        .json({ error: "start/startAt must be a valid ISO datetime" });

    if (!durationMin && !endAt)
      return res.status(400).json({ error: "Provide durationMin OR endAt" });

    const finalEndAt =
      endAt || new Date(startAt.getTime() + Number(durationMin) * 60 * 1000);

    const [learner, teacher] = await Promise.all([
      prisma.user.findUnique({
        where: { id: learnerId },
        select: { id: true, role: true, isDisabled: true },
      }),
      prisma.user.findUnique({
        where: { id: teacherId },
        select: { id: true, role: true, isDisabled: true },
      }),
    ]);

    if (!learner) return res.status(404).json({ error: "Learner not found" });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    if (learner.isDisabled)
      return res.status(400).json({ error: "Learner is disabled" });
    if (teacher.isDisabled)
      return res.status(400).json({ error: "Teacher is disabled" });

    if (learner.role !== "learner" && learner.role !== "admin") {
      return res
        .status(400)
        .json({ error: "learnerId must refer to a learner" });
    }
    if (teacherId) {
      if (!teacher) return res.status(404).json({ error: "Teacher not found" });
      if (teacher.isDisabled)
        return res.status(400).json({ error: "Teacher is disabled" });
      if (teacher.role !== "teacher")
        return res
          .status(400)
          .json({ error: "tutorId/teacherId must refer to a teacher" });
    }

    const conflicts = await findSessionConflicts({
      startAt,
      endAt: finalEndAt,
      userId: learnerId,
      teacherId: teacherId || undefined,
    });
    if (conflicts.length) {
      return res.status(409).json({ error: "Time conflict", conflicts });
    }

    const allowNoCredit = req.body.allowNoCredit === true;
    const remainingCredits = await getRemainingCredits(learnerId);

    if (!allowNoCredit && remainingCredits <= 0) {
      return res.status(422).json({
        error: "no_credits",
        message:
          "Learner has 0 remaining credits. Add a package or pass allowNoCredit: true to override.",
        remaining: 0,
      });
    }

    const created = await prisma.session.create({
      data: {
        userId: learnerId,
        teacherId,
        title,
        startAt,
        endAt: finalEndAt,
        joinUrl: meetingUrl,
        status: "scheduled",
      },
      select: {
        id: true,
        title: true,
        userId: true,
        teacherId: true,
        startAt: true,
        endAt: true,
        joinUrl: true,
        notes: true,
        status: true,
      },
    });

    await audit(req.user.id, "session_create", "Session", created.id, {
      learnerId,
      teacherId,
      startAt,
      endAt: finalEndAt,
    });

    return res.status(201).json({ ok: true, session: created });
  } catch (e) {
    logger.error({ err: e }, "admin.createSession error");
    return res.status(500).json({ error: "Failed to create session" });
  }
});

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
        if (shouldConsume) {
          const resUse = await consumeOneCredit(updated.userId);
          if (!resUse.ok) {
            logger.warn(
              { userId: updated.userId, sessionId: updated.id },
              "[credits] No active credits to consume for user"
            );
          }
        } else if (shouldRefund) {
          const resRef = await refundOneCredit(updated.userId);
          if (!resRef.ok) {
            logger.warn(
              { userId: updated.userId, sessionId: updated.id },
              "[credits] Nothing to refund for user"
            );
          }
        }
      } catch (e) {
        logger.error(
          { err: e, userId: updated.userId, sessionId: updated.id },
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
