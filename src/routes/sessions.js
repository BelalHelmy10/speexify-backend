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

const router = Router();
const prisma = new PrismaClient();

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
    console.error("conflicts endpoint error:", e);
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
    console.error(err);
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
    console.error(e);
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
    if (!id) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
        teacher: {
          select: { id: true, name: true, email: true },
        },
        feedbacks: true, // 👈 NEW
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

    const { feedbacks, ...rest } = session;
    const learnerFeedback = feedbacks.find((f) => f.role === "LEARNER") || null;
    const teacherFeedback = feedbacks.find((f) => f.role === "TEACHER") || null;

    return res.json({
      session: {
        ...rest,
        learnerFeedback,
        teacherFeedback,
      },
    });
  } catch (err) {
    console.error("GET /sessions/:id failed:", err);
    return res.status(500).json({ error: "Failed to load session" });
  }
});

// --------------------------------------------------------------------------
// Learner feedback
// POST /api/sessions/:id/feedback/learner
// --------------------------------------------------------------------------
router.post("/sessions/:id/feedback/learner", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const { rating, notes } = req.body;
    const notesStr = (notes ?? "").toString().trim() || null;

    let ratingNum = null;
    if (rating !== undefined && rating !== null && rating !== "") {
      const parsed = Number(rating);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) {
        return res
          .status(400)
          .json({ error: "Rating must be a number between 1 and 5" });
      }
      ratingNum = Math.round(parsed);
    }

    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        startAt: true,
        endAt: true,
        status: true,
      },
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // only the learner (or admin) can submit learner feedback
    const isLearner = session.userId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isLearner || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // only allow after the session has started
    const now = new Date();
    if (new Date(session.startAt) > now) {
      return res
        .status(400)
        .json({ error: "You can only leave feedback after the session" });
    }

    const role = "LEARNER";

    const fb = await prisma.sessionFeedback.upsert({
      where: {
        sessionId_role: { sessionId: id, role },
      },
      update: {
        rating: ratingNum,
        notes: notesStr,
      },
      create: {
        sessionId: id,
        role,
        rating: ratingNum,
        notes: notesStr,
      },
    });

    // Mirror learner rating onto Session.feedbackScore
    if (ratingNum !== null) {
      await prisma.session.update({
        where: { id },
        data: { feedbackScore: ratingNum },
      });
    }

    return res.json({ ok: true, feedback: fb });
  } catch (err) {
    console.error("POST /sessions/:id/feedback/learner failed:", err);
    return res.status(500).json({ error: "Failed to submit feedback" });
  }
});

// --------------------------------------------------------------------------
// Teacher feedback
// POST /api/sessions/:id/feedback/teacher
// --------------------------------------------------------------------------
router.post("/sessions/:id/feedback/teacher", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const { rating, notes } = req.body;
    const notesStr = (notes ?? "").toString().trim() || null;

    let ratingNum = null;
    if (rating !== undefined && rating !== null && rating !== "") {
      const parsed = Number(rating);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) {
        return res
          .status(400)
          .json({ error: "Rating must be a number between 1 and 5" });
      }
      ratingNum = Math.round(parsed);
    }

    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        teacherId: true,
        startAt: true,
        endAt: true,
        status: true,
      },
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const now = new Date();
    if (new Date(session.startAt) > now) {
      return res
        .status(400)
        .json({ error: "You can only leave feedback after the session" });
    }

    const role = "TEACHER";

    const fb = await prisma.sessionFeedback.upsert({
      where: {
        sessionId_role: { sessionId: id, role },
      },
      update: {
        rating: ratingNum,
        notes: notesStr,
      },
      create: {
        sessionId: id,
        role,
        rating: ratingNum,
        notes: notesStr,
      },
    });

    return res.json({ ok: true, feedback: fb });
  } catch (err) {
    console.error("POST /sessions/:id/feedback/teacher failed:", err);
    return res.status(500).json({ error: "Failed to submit feedback" });
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
        await consumeOneCredit(s.userId);
      } catch (e) {
        console.error(e);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("complete error:", e);
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
        if (!r.ok)
          console.warn("[credits] cancel refund not applied (none to refund)");
      }
    } catch (e) {
      console.error("[credits] cancel refund failed:", e?.message || e);
    }

    res.json({ ok: true, session: updated });
  } catch (e) {
    console.error("Cancel failed:", e);
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
    console.error("reschedule error:", e);
    res.status(400).json({ error: "Failed to reschedule session" });
  }
});

router.get("/me/sessions", requireAuth, async (req, res) => {
  try {
    // Don't let finalization break the endpoint
    try {
      await finalizeExpiredSessionsForUser(req.viewUserId);
    } catch (e) {
      console.error("finalizeExpiredSessionsForUser failed:", e);
    }

    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { range = "upcoming", limit = 10 } = req.query;
    const now = new Date();

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

    const where =
      range === "past"
        ? { AND: [whereBase, { status: "completed" }] } // only completed
        : { AND: [whereBase, notCanceled, inProgressOrFuture] }; // future + in-progress

    const orderBy = range === "past" ? { startAt: "desc" } : { startAt: "asc" };

    const sessions = await prisma.session.findMany({
      where,
      orderBy,
      take: Number(limit) || 10,
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
        status: true,
        feedbackScore: true,
      },
    });

    res.json(sessions);
  } catch (e) {
    console.error("GET /me/sessions failed:", e);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

router.get("/me/sessions-between", requireAuth, async (req, res) => {
  try {
    // Don't let finalization break the endpoint
    try {
      await finalizeExpiredSessionsForUser(req.viewUserId);
    } catch (e) {
      console.error("finalizeExpiredSessionsForUser failed:", e);
    }

    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { start, end } = req.query;
    const includeCanceled = String(req.query.includeCanceled) === "true";

    const startAt = start ? new Date(start) : new Date("1970-01-01");
    const endAt = end ? new Date(end) : new Date("2999-12-31");

    const whereBase =
      role === "teacher"
        ? { OR: [{ userId }, { teacherId: userId }] }
        : { userId };

    const sessions = await prisma.session.findMany({
      where: {
        AND: [
          whereBase,
          includeCanceled ? {} : { status: { not: "canceled" } },
          { startAt: { lte: endAt } },
          { OR: [{ endAt: { gte: startAt } }, { endAt: null }] },
        ],
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
        status: true,
      },
    });

    res.json(sessions);
  } catch (e) {
    console.error("GET /me/sessions-between failed:", e);
    res.status(500).json({
      error: e?.message || e?.meta?.cause || "Failed to load calendar sessions",
    });
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
              { meetingUrl: { contains: q, mode: "insensitive" } },
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
    console.error("admin.sessions.list error:", err);
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
        meetingUrl,
        status: "scheduled",
      },
      select: {
        id: true,
        title: true,
        userId: true,
        teacherId: true,
        startAt: true,
        endAt: true,
        meetingUrl,
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
    console.error("admin.createSession error:", e);
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
        "meetingUrl",
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
            console.warn(
              "[credits] No active credits to consume for user",
              updated.userId
            );
          }
        } else if (shouldRefund) {
          const resRef = await refundOneCredit(updated.userId);
          if (!resRef.ok) {
            console.warn(
              "[credits] Nothing to refund for user",
              updated.userId
            );
          }
        }
      } catch (e) {
        console.error("[credits] accounting failure:", e?.message || e);
      }

      await audit(req.user.id, "session_update", "Session", id, patch);
      res.json(updated);
    } catch (err) {
      console.error("admin.sessions.patch error:", err);
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
      console.error("admin.sessions.delete error:", err);
      res.status(500).json({ error: "Failed to delete session" });
    }
  }
);

export default router;
