import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import {
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCredit,
  refundOneCredit,
  finalizeExpiredSessionsForUser,
  finalizeExpiredSessionsForTeacher,
} from "../services/sessionsService.js";
import {
  createNotification,
  sendBookingNotifications,
  sendCancellationNotifications,
  sendFeedbackNotifications, // ← ADD THIS
} from "../services/notificationsService.js";
import { logger } from "../lib/logger.js";

const router = Router();

// Simple audit stub to avoid ReferenceError and keep logs
async function audit(userId, action, entity, entityId, meta = {}) {
  logger.info({ userId, action, entity, entityId, meta }, "audit event");
}

/* ========================================================================== */
/*                             SESSIONS (LESSONS)                             */
/* ========================================================================== */

// --------------------------------------------------------------------------
// GET /api/sessions/conflicts - Check for scheduling conflicts
// --------------------------------------------------------------------------
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

// --------------------------------------------------------------------------
// GET /api/sessions - List sessions for current user (learner view)
// FIX: Include both participants AND legacy userId field
// --------------------------------------------------------------------------
router.get("/sessions", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;

    const sessions = await prisma.session.findMany({
      where: {
        // FIX: Check BOTH participant membership AND legacy userId
        OR: [
          { participants: { some: { userId } } },
          { userId }, // Legacy 1:1 sessions
        ],
      },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
        user: { select: { id: true, name: true, email: true } }, // Legacy learner
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

// --------------------------------------------------------------------------
// GET /api/teacher/sessions - List sessions for teacher
// --------------------------------------------------------------------------
router.get("/teacher/sessions", requireAuth, async (req, res) => {
  try {
    const teacherId = req.viewUserId;

    // Finalize any expired sessions first
    try {
      await finalizeExpiredSessionsForTeacher(teacherId);
    } catch (e) {
      logger.error(
        { err: e, teacherId },
        "finalizeExpiredSessionsForTeacher failed"
      );
    }

    const sessions = await prisma.session.findMany({
      where: { teacherId },
      include: {
        // Legacy 1:1 learner (may be null for group)
        user: { select: { id: true, email: true, name: true } },
        // Group learners
        participants: {
          select: {
            userId: true,
            status: true,
            attendedAt: true,
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
      orderBy: { startAt: "asc" },
    });

    // Shape response with participant counts
    const shaped = sessions.map((s) => {
      const activeParticipants = (s.participants || []).filter(
        (p) => p.status !== "canceled"
      );
      return {
        ...s,
        participantCount: activeParticipants.length,
        // For GROUP sessions, provide a learners array
        learners:
          s.type === "GROUP"
            ? activeParticipants.map((p) => p.user)
            : s.user
            ? [s.user]
            : [],
      };
    });

    res.json(shaped);
  } catch (e) {
    logger.error({ err: e }, "GET /teacher/sessions failed");
    res.status(500).json({ error: "Failed to load teacher sessions" });
  }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id - Get single session details
// --------------------------------------------------------------------------
router.get("/sessions/:id", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || Number.isNaN(id)) {
      return res.status(400).json({ error: "Invalid session id" });
    }

    const session = await prisma.session.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true } }, // Legacy 1:1 learner
        teacher: { select: { id: true, name: true, email: true } },
        participants: {
          select: {
            userId: true,
            status: true,
            attendedAt: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
        feedback: true, // FIX: Use correct relation name
      },
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const viewerId = req.viewUserId;
    const isParticipant = session.participants.some(
      (p) => p.userId === viewerId
    );

    // Permission: learner participant OR legacy owner OR teacher OR admin
    const isLearner = isParticipant || session.userId === viewerId;
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isLearner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Build teacher feedback from either new relation or legacy fields
    const feedbackFromRelation = session.feedback;
    const hasLegacyFeedback =
      !!session.teacherFeedbackMessageToLearner ||
      !!session.teacherFeedbackComments ||
      !!session.teacherFeedbackFutureSteps;

    const teacherFeedback = feedbackFromRelation
      ? {
          messageToLearner: feedbackFromRelation.messageToLearner || "",
          commentsOnSession: feedbackFromRelation.commentsOnSession || "",
          futureSteps: feedbackFromRelation.futureSteps || "",
        }
      : hasLegacyFeedback
      ? {
          messageToLearner: session.teacherFeedbackMessageToLearner || "",
          commentsOnSession: session.teacherFeedbackComments || "",
          futureSteps: session.teacherFeedbackFutureSteps || "",
        }
      : null;

    // Calculate participant info
    const activeParticipants = (session.participants || []).filter(
      (p) => p.status !== "canceled"
    );

    const shaped = {
      ...session,
      isLearner,
      isTeacher,
      isAdmin,
      teacherFeedback,
      participantCount: activeParticipants.length,
      // For GROUP sessions, list all learners
      learners:
        session.type === "GROUP"
          ? activeParticipants.map((p) => ({
              ...p.user,
              status: p.status,
              attendedAt: p.attendedAt,
            }))
          : session.user
          ? [{ ...session.user, status: "booked" }]
          : [],
    };

    // Remove redundant fields from response
    delete shaped.teacherFeedbackMessageToLearner;
    delete shaped.teacherFeedbackComments;
    delete shaped.teacherFeedbackFutureSteps;

    return res.json({ session: shaped });
  } catch (err) {
    logger.error({ err }, "GET /sessions/:id failed");
    return res.status(500).json({ error: "Failed to load session" });
  }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/feedback - Get detailed teacher feedback
// FIX: Use correct relation name and handle both sources
// --------------------------------------------------------------------------
router.get("/sessions/:id/feedback", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        teacherId: true,
        participants: { select: { userId: true } },
        feedback: true, // FIX: Correct relation name
        // Also get legacy fields as fallback
        teacherFeedbackMessageToLearner: true,
        teacherFeedbackComments: true,
        teacherFeedbackFutureSteps: true,
      },
    });

    if (!session) return res.status(404).json({ error: "Session not found" });

    // Check permissions
    const viewerId = req.viewUserId;
    const isParticipant = session.participants.some(
      (p) => p.userId === viewerId
    );
    const isLearner = isParticipant || session.userId === viewerId;
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isLearner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Return feedback from relation or legacy fields
    if (session.feedback) {
      return res.json(session.feedback);
    }

    // Fallback to legacy fields
    const hasLegacy =
      session.teacherFeedbackMessageToLearner ||
      session.teacherFeedbackComments ||
      session.teacherFeedbackFutureSteps;

    if (hasLegacy) {
      return res.json({
        messageToLearner: session.teacherFeedbackMessageToLearner || "",
        commentsOnSession: session.teacherFeedbackComments || "",
        futureSteps: session.teacherFeedbackFutureSteps || "",
      });
    }

    res.json(null);
  } catch (e) {
    logger.error({ err: e }, "GET /sessions/:id/feedback error");
    res.status(500).json({ error: "Failed to load feedback" });
  }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/feedback - Create/update detailed teacher feedback
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// POST /api/sessions/:id/feedback - Create/update detailed teacher feedback
// --------------------------------------------------------------------------
router.post("/sessions/:id/feedback", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        userId: true,
        teacherId: true,
        startAt: true,
        type: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (!session) return res.status(404).json({ error: "Session not found" });

    // Only the teacher assigned to this session (or admin) can write feedback
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isTeacher || isAdmin)) {
      return res
        .status(403)
        .json({ error: "Only the teacher can give feedback" });
    }

    // Only allow after the session has started
    const now = new Date();
    if (new Date(session.startAt) > now) {
      return res
        .status(400)
        .json({ error: "You can only leave feedback after the session" });
    }

    const messageToLearner = String(req.body?.messageToLearner || "").trim();
    const commentsOnSession = String(req.body?.commentsOnSession || "").trim();
    const futureSteps = String(req.body?.futureSteps || "").trim();

    // Check if feedback already exists (to know if this is new or update)
    const existingFeedback = await prisma.sessionFeedback.findUnique({
      where: { sessionId: session.id },
    });

    const isNewFeedback = !existingFeedback;

    const feedback = await prisma.sessionFeedback.upsert({
      where: { sessionId: session.id },
      update: {
        messageToLearner,
        commentsOnSession,
        futureSteps,
      },
      create: {
        sessionId: session.id,
        teacherId: req.user.id,
        messageToLearner,
        commentsOnSession,
        futureSteps,
      },
    });

    // ✅ Send notification + email only for NEW feedback (not updates)
    if (isNewFeedback) {
      try {
        // Get learner IDs
        const learnerIds = [];
        if (session.type === "GROUP") {
          const activeParticipants = (session.participants || [])
            .filter((p) => p.status !== "canceled")
            .map((p) => p.userId);
          learnerIds.push(...activeParticipants);
        } else {
          // ONE_ON_ONE - check legacy userId or participants
          if (session.userId) {
            learnerIds.push(session.userId);
          } else if (session.participants?.length) {
            const active = session.participants
              .filter((p) => p.status !== "canceled")
              .map((p) => p.userId);
            learnerIds.push(...active);
          }
        }

        if (learnerIds.length > 0) {
          await sendFeedbackNotifications({
            session,
            learnerIds,
            teacherId: req.user.id,
            feedback: {
              messageToLearner,
              commentsOnSession,
              futureSteps,
            },
          });
        }
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id },
          "feedback notifications failed"
        );
        // Don't fail the request if notifications fail
      }
    }

    res.json({ ok: true, feedback });
  } catch (e) {
    logger.error({ err: e }, "POST /sessions/:id/feedback error");
    res.status(500).json({ error: "Failed to save feedback" });
  }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/feedback/teacher - Legacy feedback endpoint
// --------------------------------------------------------------------------
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
      return next(err);
    }
  }
);

// --------------------------------------------------------------------------
// POST /api/sessions/:id/attendance - Mark attendance per participant
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

// --------------------------------------------------------------------------
// POST /api/sessions/:id/complete - Mark session as completed
// FIX: Unified credit consumption - consume for ALL non-canceled participants
// --------------------------------------------------------------------------
router.post("/sessions/:id/complete", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        userId: true,
        teacherId: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (!session) return res.status(404).json({ error: "Not found" });

    const canComplete =
      req.user.role === "admin" ||
      req.user.id === session.teacherId ||
      req.user.id === session.userId;

    if (!canComplete) return res.status(403).json({ error: "Forbidden" });

    // Already completed - do nothing
    if (session.status === "completed") {
      return res.json({ ok: true, alreadyCompleted: true });
    }

    // Update status to completed
    await prisma.session.update({
      where: { id },
      data: { status: "completed" },
    });

    // Credits are consumed on booking, not on completion
    // No credit operations needed here

    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "complete error");
    res.status(500).json({ error: "Failed to complete session" });
  }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/cancel - Cancel session or participant seat
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// POST /api/sessions/:id/cancel - Cancel session or participant seat
// --------------------------------------------------------------------------
router.post("/sessions/:id/cancel", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    const sessionRow = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        userId: true,
        teacherId: true,
        joinUrl: true,
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

      // Refund only this learner if policy allows
      let refunded = false;
      if (refundableByLearner && sessionRow.status !== "completed") {
        try {
          const r = await refundOneCredit(viewerId);
          refunded = r.ok;
        } catch (e) {
          logger.error(
            { err: e, userId: viewerId, sessionId: sessionRow.id },
            "[credits] group seat cancel refund failed"
          );
        }
      }

      // ✅ Send cancellation notifications (in-app + email)
      try {
        await sendCancellationNotifications({
          session: sessionRow,
          learnerIds: [viewerId],
          teacherId: sessionRow.teacherId,
          canceledBy: req.user.id,
          scope: "participant",
          refunded,
        });
      } catch (e) {
        logger.error(
          { err: e, sessionId: sessionRow.id },
          "cancellation notifications failed"
        );
      }

      return res.json({
        ok: true,
        scope: "participant",
        refunded,
      });
    }

    // ─────────────────────────────────────────────
    // Otherwise: cancel the whole session
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

    const refundableWholeSession =
      startsAt.getTime() - Date.now() >= twelveHoursMs &&
      sessionRow.status !== "completed";

    const refundResults = [];

    // Handle refunds
    if (refundableWholeSession) {
      if (sessionRow.type === "GROUP") {
        const seats = (sessionRow.participants || [])
          .filter((p) => p.status !== "canceled")
          .map((p) => p.userId);

        for (const learnerId of seats) {
          try {
            const r = await refundOneCredit(learnerId);
            refundResults.push({ learnerId, refunded: r.ok });
          } catch (e) {
            logger.error(
              { err: e, userId: learnerId, sessionId: sessionRow.id },
              "[credits] group cancel refund failed"
            );
            refundResults.push({ learnerId, refunded: false });
          }
        }
      } else {
        const learnerId =
          sessionRow.userId ||
          (sessionRow.participants?.length
            ? sessionRow.participants[0].userId
            : null);

        if (learnerId) {
          try {
            const r = await refundOneCredit(learnerId);
            refundResults.push({ learnerId, refunded: r.ok });
          } catch (e) {
            logger.error(
              { err: e, userId: learnerId, sessionId: sessionRow.id },
              "[credits] cancel refund failed"
            );
            refundResults.push({ learnerId, refunded: false });
          }
        }
      }
    }

    // ✅ Determine recipients
    const learnerIds = [];
    if (sessionRow.type === "GROUP") {
      const active = (sessionRow.participants || [])
        .filter((p) => p.status !== "canceled")
        .map((p) => p.userId);
      learnerIds.push(...active);
    } else {
      const learnerId =
        sessionRow.userId ||
        (sessionRow.participants?.length
          ? sessionRow.participants[0].userId
          : null);
      if (learnerId) learnerIds.push(learnerId);
    }

    // ✅ Send cancellation notifications (in-app + email)
    try {
      await sendCancellationNotifications({
        session: sessionRow,
        learnerIds,
        teacherId: sessionRow.teacherId,
        canceledBy: req.user.id,
        scope: "session",
        refunded: refundableWholeSession,
      });
    } catch (e) {
      logger.error(
        { err: e, sessionId: sessionRow.id },
        "cancellation notifications failed"
      );
    }

    return res.json({
      ok: true,
      scope: "session",
      refunded: refundableWholeSession,
      refundResults,
      session: updated,
    });
  } catch (e) {
    logger.error({ err: e }, "Cancel failed");
    res.status(400).json({ error: "Failed to cancel session" });
  }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/reschedule - Reschedule a session
// FIX: Check conflicts for ALL participants in GROUP sessions
// --------------------------------------------------------------------------
router.post("/sessions/:id/reschedule", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { startAt, endAt } = req.body;

    if (!startAt) return res.status(400).json({ error: "startAt is required" });

    const session = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        userId: true,
        teacherId: true,
        status: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (!session) return res.status(404).json({ error: "Not found" });

    const isOwner = session.userId === req.user.id;
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isOwner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const newStart = new Date(startAt);
    const newEnd = endAt ? new Date(endAt) : null;

    // FIX: Check conflicts for ALL active participants in GROUP sessions
    if (session.type === "GROUP") {
      const activeParticipants = (session.participants || [])
        .filter((p) => p.status !== "canceled")
        .map((p) => p.userId);

      for (const participantId of activeParticipants) {
        const conflicts = await findSessionConflicts({
          startAt: newStart,
          endAt: newEnd,
          userId: participantId,
          teacherId: session.teacherId,
          excludeId: id,
        });

        if (conflicts.length) {
          return res.status(409).json({
            error: "Time conflict",
            conflictingUserId: participantId,
            conflicts,
          });
        }
      }
    } else {
      // ONE_ON_ONE: check legacy userId
      const conflicts = await findSessionConflicts({
        startAt: newStart,
        endAt: newEnd,
        userId: session.userId,
        teacherId: session.teacherId,
        excludeId: id,
      });

      if (conflicts.length) {
        return res.status(409).json({ error: "Time conflict", conflicts });
      }
    }

    const updated = await prisma.session.update({
      where: { id },
      data: {
        startAt: newStart,
        endAt: newEnd,
        status: "scheduled",
      },
    });

    res.json({ ok: true, session: updated });
  } catch (e) {
    logger.error({ err: e }, "reschedule error");
    res.status(400).json({ error: "Failed to reschedule session" });
  }
});

// --------------------------------------------------------------------------
// GET /api/me/sessions - List sessions for current user
// --------------------------------------------------------------------------
router.get("/me/sessions", requireAuth, async (req, res) => {
  try {
    // ✅ Admin dashboard should not use "my sessions"
    if (req.user.role === "admin") {
      return res.json([]);
    }

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

    // Membership base: include both participants AND legacy userId
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
        userId: true,
        teacher: { select: { id: true, name: true, email: true } },
        user: { select: { id: true, name: true, email: true } },
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
        feedback: { select: { id: true } },
      },
    });

    const sessions = rawSessions.map((s) => {
      const hasFeedback =
        !!s.feedback ||
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
        feedback,
        ...rest
      } = s;

      const activeParticipants = (rest.participants || []).filter(
        (p) => p.status !== "canceled"
      );

      return {
        ...rest,
        participantCount: activeParticipants.length,
        // For GROUP sessions, include learner list
        learners:
          rest.type === "GROUP"
            ? activeParticipants.map((p) => p.user)
            : rest.user
            ? [rest.user]
            : [],
        teacherFeedback,
        hasFeedback,
      };
    });

    res.json(sessions);
  } catch (e) {
    logger.error({ err: e }, "GET /me/sessions failed");
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// --------------------------------------------------------------------------
// GET /api/me/sessions-between - Get sessions in date range (calendar)
// --------------------------------------------------------------------------
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
        participants: {
          select: { userId: true, status: true },
        },
      },
    });

    const shaped = sessions.map((s) => {
      const activeCount = (s.participants || []).filter(
        (p) => p.status !== "canceled"
      ).length;

      return {
        ...s,
        participantCount: activeCount,
        teacherFeedback: s.feedback,
      };
    });

    return res.json({ sessions: shaped });
  } catch (e) {
    logger.error({ err: e }, "GET /me/sessions-between failed");
    return res.status(500).json({
      error: e?.message || e?.meta?.cause || "Failed to load calendar sessions",
    });
  }
});

// --------------------------------------------------------------------------
// GET /api/me/progress - Learner progress summary
// --------------------------------------------------------------------------
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
    return res
      .status(500)
      .json({ error: err?.message || "Failed to load progress" });
  }
});

/* ========================================================================== */
/*                               ADMIN: SESSIONS                              */
/* ========================================================================== */

// --------------------------------------------------------------------------
// GET /api/admin/sessions - List all sessions (admin)
// --------------------------------------------------------------------------
router.get("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      q = "",
      userId = "",
      teacherId = "",
      type = "",
      range = "",
      limit = "100",
      offset = "0",
    } = req.query;

    const now = new Date();
    const where = {};

    // Filter by legacy userId OR participant
    if (userId) {
      const uid = Number(userId);
      where.OR = [{ userId: uid }, { participants: { some: { userId: uid } } }];
    }

    if (teacherId) {
      where.teacherId = Number(teacherId);
    }

    if (type === "ONE_ON_ONE" || type === "GROUP") {
      where.type = type;
    }

    if (q) {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { joinUrl: { contains: q, mode: "insensitive" } },
          ],
        },
      ];
    }

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
          participants: {
            select: {
              userId: true,
              status: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
        orderBy: [{ startAt: "desc" }, { id: "desc" }],
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.session.count({ where }),
    ]);

    // Shape response with participant info
    const shaped = items.map((s) => {
      const activeParticipants = (s.participants || []).filter(
        (p) => p.status !== "canceled"
      );
      return {
        ...s,
        participantCount: activeParticipants.length,
        learners:
          s.type === "GROUP"
            ? activeParticipants.map((p) => ({
                ...p.user,
                status: p.status,
              }))
            : s.user
            ? [{ ...s.user, status: "booked" }]
            : [],
      };
    });

    res.json({ items: shaped, total });
  } catch (err) {
    logger.error({ err }, "admin.sessions.list error");
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// --------------------------------------------------------------------------
// POST /api/admin/sessions - Create new session (1:1 or GROUP)
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// POST /api/admin/sessions - Create new session (1:1 or GROUP)
// --------------------------------------------------------------------------
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
      joinUrl,
      meetingUrl,
      notes,
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

    const finalJoinUrl = (joinUrl ?? meetingUrl ?? "").trim() || null;
    const finalNotes = (notes ?? "").trim() || null;

    // ─────────────────────────────────────────────
    // ONE_ON_ONE SESSION
    // ─────────────────────────────────────────────
    if (type === "ONE_ON_ONE") {
      if (!learnerId) {
        return res.status(400).json({ error: "learnerId is required" });
      }

      const learner = await prisma.user.findUnique({
        where: { id: Number(learnerId) },
        select: { id: true, role: true, isDisabled: true },
      });

      if (!learner || learner.isDisabled) {
        return res.status(404).json({
          error: "User not found or disabled",
          userId: Number(learnerId),
        });
      }
      if (learner.role !== "learner" && learner.role !== "admin") {
        return res.status(400).json({
          error: "learnerId must refer to a learner",
          userId: Number(learnerId),
        });
      }

      // Conflict check
      const conflicts = await findSessionConflicts({
        startAt: start,
        endAt: finalEndAt,
        userId: Number(learnerId),
        teacherId,
      });

      if (conflicts.length) {
        return res.status(409).json({ error: "Time conflict", conflicts });
      }

      // Credit check
      const remaining = await getRemainingCredits(Number(learnerId));
      if (!allowNoCredit && remaining <= 0) {
        return res.status(422).json({
          error: "no_credits",
          message: "Learner has no remaining credits",
          learnerId: Number(learnerId),
        });
      }

      const session = await prisma.session.create({
        data: {
          type: "ONE_ON_ONE",
          userId: Number(learnerId),
          teacherId: teacherId || null,
          title,
          startAt: start,
          endAt: finalEndAt,
          joinUrl: finalJoinUrl,
          notes: finalNotes,
        },
      });

      // Also create participant row for consistency
      await prisma.sessionParticipant.create({
        data: {
          sessionId: session.id,
          userId: Number(learnerId),
        },
      });

      // Consume credit on booking (not on completion)
      // Consume credit on booking (not on completion)
      let creditResult = null;
      console.log("========== CREDIT DEBUG ==========");
      console.log("learnerId:", Number(learnerId));
      console.log(
        "allowNoCredit:",
        allowNoCredit,
        "type:",
        typeof allowNoCredit
      );
      if (!allowNoCredit) {
        console.log(">>> ENTERING credit consumption");
        try {
          creditResult = await consumeOneCredit(Number(learnerId));
          console.log(
            ">>> consumeOneCredit result:",
            JSON.stringify(creditResult)
          );
          if (!creditResult.ok) {
            logger.warn(
              { userId: Number(learnerId), sessionId: session.id },
              "[credits] Failed to consume credit on booking"
            );
          }
        } catch (e) {
          console.log(">>> EXCEPTION:", e.message);
          logger.error(
            { err: e, userId: Number(learnerId), sessionId: session.id },
            "[credits] consumeOneCredit failed on session create"
          );
        }
      } else {
        console.log(">>> SKIPPED - allowNoCredit is truthy");
      }
      console.log("========== END DEBUG ==========");

      await audit(req.user.id, "session_create", "Session", session.id, {
        type: "ONE_ON_ONE",
        learnerId: Number(learnerId),
        teacherId,
        creditConsumed: creditResult?.ok || false,
      });

      // ✅ Send booking notifications (in-app + email) to learner AND teacher
      try {
        await sendBookingNotifications({
          session,
          learnerIds: [Number(learnerId)],
          teacherId: teacherId || null,
          bookedBy: req.user.id,
        });
      } catch (e) {
        logger.error(
          { err: e, learnerId: Number(learnerId), sessionId: session.id },
          "booking notifications failed"
        );
      }

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

    const uniqueLearnerIds = Array.from(
      new Set(
        learnerIds.map((x) => Number(x)).filter((n) => n && !Number.isNaN(n))
      )
    );

    if (!uniqueLearnerIds.length) {
      return res
        .status(400)
        .json({ error: "learnerIds[] must contain valid ids" });
    }

    if (capacity && uniqueLearnerIds.length > capacity) {
      return res.status(400).json({
        error: "capacity_exceeded",
        message: "learnerIds exceed session capacity",
      });
    }

    // Validate users + conflicts + credits PER learner
    for (const uid of uniqueLearnerIds) {
      const u = await prisma.user.findUnique({
        where: { id: uid },
        select: { id: true, role: true, isDisabled: true },
      });

      if (!u || u.isDisabled) {
        return res
          .status(404)
          .json({ error: "User not found or disabled", learnerId: uid });
      }
      if (u.role !== "learner" && u.role !== "admin") {
        return res
          .status(400)
          .json({ error: "learnerIds must refer to learners", learnerId: uid });
      }

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
        teacherId: teacherId || null,
        title,
        startAt: start,
        endAt: finalEndAt,
        joinUrl: finalJoinUrl,
        notes: finalNotes,
        // No userId for GROUP sessions
      },
    });

    await prisma.sessionParticipant.createMany({
      data: uniqueLearnerIds.map((uid) => ({
        sessionId: session.id,
        userId: uid,
      })),
      skipDuplicates: true,
    });

    // Consume credit for each learner on booking (not on completion)
    const creditResults = [];
    if (!allowNoCredit) {
      for (const uid of uniqueLearnerIds) {
        try {
          const result = await consumeOneCredit(uid);
          creditResults.push({ learnerId: uid, consumed: result.ok });
          if (!result.ok) {
            logger.warn(
              { userId: uid, sessionId: session.id },
              "[credits] Failed to consume credit on GROUP booking"
            );
          }
        } catch (e) {
          logger.error(
            { err: e, userId: uid, sessionId: session.id },
            "[credits] consumeOneCredit failed on GROUP session create"
          );
          creditResults.push({ learnerId: uid, consumed: false });
        }
      }
    }

    await audit(req.user.id, "session_create", "Session", session.id, {
      type: "GROUP",
      learnerIds: uniqueLearnerIds,
      teacherId,
      capacity,
      creditResults,
    });

    // ✅ Send booking notifications (in-app + email) to all learners AND teacher
    try {
      await sendBookingNotifications({
        session,
        learnerIds: uniqueLearnerIds,
        teacherId: teacherId || null,
        bookedBy: req.user.id,
      });
    } catch (e) {
      logger.error(
        { err: e, learnerIds: uniqueLearnerIds, sessionId: session.id },
        "booking notifications failed (group)"
      );
    }

    return res.status(201).json({ ok: true, session });
  } catch (e) {
    logger.error({ err: e }, "admin.createSession error");
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// --------------------------------------------------------------------------
// POST /api/admin/sessions/:id/participants - Add participants to GROUP session
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

      // Consume credit for each added learner on booking (not on completion)
      const creditResults = [];
      if (!allowNoCredit) {
        for (const uid of toAdd) {
          try {
            const result = await consumeOneCredit(uid);
            creditResults.push({ learnerId: uid, consumed: result.ok });
            if (!result.ok) {
              logger.warn(
                { userId: uid, sessionId },
                "[credits] Failed to consume credit when adding participant"
              );
            }
          } catch (e) {
            logger.error(
              { err: e, userId: uid, sessionId },
              "[credits] consumeOneCredit failed when adding participant"
            );
            creditResults.push({ learnerId: uid, consumed: false });
          }
        }
      }

      await audit(
        req.user.id,
        "session_add_participants",
        "Session",
        sessionId,
        {
          addedUserIds: toAdd,
          creditResults,
        }
      );

      // ✅ Send booking notifications to newly added participants
      try {
        await sendBookingNotifications({
          session,
          learnerIds: toAdd,
          teacherId: session.teacherId,
          bookedBy: req.user.id,
        });
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id },
          "booking notifications failed for added participants"
        );
      }

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
// DELETE /api/admin/sessions/:id/participants/:userId - Remove participant
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

      await audit(
        req.user.id,
        "session_remove_participant",
        "Session",
        sessionId,
        {
          removedUserId: targetUserId,
          refunded,
        }
      );

      return res.json({ ok: true, removed: true, refunded });
    } catch (e) {
      logger.error({ err: e }, "admin.sessions.removeParticipant error");
      return res.status(500).json({ error: "Failed to remove participant" });
    }
  }
);

// --------------------------------------------------------------------------
// PATCH /api/admin/sessions/:id - Update session
// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// PATCH /api/admin/sessions/:id - Update session
// --------------------------------------------------------------------------
router.patch(
  "/admin/sessions/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await prisma.session.findUnique({
        where: { id },
        select: {
          id: true,
          type: true,
          status: true,
          startAt: true,
          endAt: true,
          userId: true,
          teacherId: true,
          participants: { select: { userId: true, status: true } },
        },
      });

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
        "capacity",
        "notes",
      ];
      for (const k of allowed) {
        if (req.body[k] !== undefined) patch[k] = req.body[k];
      }

      // Backward-compat: admin UI sends meetingUrl, but DB field is joinUrl
      if (patch.joinUrl === undefined && req.body.meetingUrl !== undefined) {
        patch.joinUrl = req.body.meetingUrl;
      }

      // Normalize simple string fields
      if (patch.joinUrl !== undefined) {
        patch.joinUrl = String(patch.joinUrl || "").trim() || null;
      }
      if (patch.notes !== undefined) {
        patch.notes = String(patch.notes || "").trim() || null;
      }

      // Validate time/user changes for conflicts
      const start = patch.startAt ? new Date(patch.startAt) : existing.startAt;
      const end = patch.endAt ? new Date(patch.endAt) : existing.endAt;
      const teacherId =
        patch.teacherId !== undefined
          ? Number(patch.teacherId)
          : existing.teacherId;

      if (patch.startAt || patch.endAt || patch.teacherId) {
        // Check conflicts for ALL participants if GROUP
        if (existing.type === "GROUP") {
          const activeParticipants = (existing.participants || [])
            .filter((p) => p.status !== "canceled")
            .map((p) => p.userId);

          for (const participantId of activeParticipants) {
            const conflicts = await findSessionConflicts({
              startAt: start,
              endAt: end,
              userId: participantId,
              teacherId,
              excludeId: id,
            });
            if (conflicts.length) {
              return res.status(409).json({
                error: "Time conflict",
                conflictingUserId: participantId,
                conflicts,
              });
            }
          }
        } else {
          // ONE_ON_ONE
          const userId =
            patch.userId !== undefined ? Number(patch.userId) : existing.userId;

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
      }

      // Type conversions
      if (patch.userId !== undefined)
        patch.userId = Number(patch.userId) || null;
      if (patch.teacherId !== undefined)
        patch.teacherId = Number(patch.teacherId) || null;
      if (patch.capacity !== undefined)
        patch.capacity = Number(patch.capacity) || null;
      if (patch.startAt !== undefined) patch.startAt = new Date(patch.startAt);
      if (patch.endAt !== undefined)
        patch.endAt = patch.endAt ? new Date(patch.endAt) : null;

      const prevStatus = existing.status;
      const nextStatus = patch.status ?? existing.status;

      // Credits are consumed on booking, not on completion
      // Only refund when transitioning TO canceled status
      let shouldRefund = false;

      if (prevStatus !== "canceled" && nextStatus === "canceled") {
        shouldRefund = true;
      }

      const updated = await prisma.session.update({
        where: { id },
        data: patch,
        include: {
          user: { select: { id: true, name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
          participants: {
            select: {
              userId: true,
              status: true,
              user: { select: { id: true, name: true, email: true } },
            },
          },
        },
      });

      // Handle credit refund when canceling via admin PATCH
      const creditResults = [];

      if (shouldRefund) {
        if (existing.type === "GROUP") {
          const seats = (existing.participants || [])
            .filter((p) => p.status !== "canceled")
            .map((p) => p.userId);

          for (const learnerId of seats) {
            try {
              const resRef = await refundOneCredit(learnerId);
              creditResults.push({
                learnerId,
                action: "refund",
                ok: resRef.ok,
              });
            } catch (e) {
              logger.error(
                { err: e, userId: learnerId, sessionId: updated.id },
                "[credits] refund failed on admin cancel"
              );
              creditResults.push({
                learnerId,
                action: "refund",
                ok: false,
              });
            }
          }
        } else {
          // ONE_ON_ONE
          const learnerId =
            existing.userId ||
            (existing.participants?.length
              ? existing.participants[0].userId
              : null);

          if (learnerId) {
            try {
              const resRef = await refundOneCredit(learnerId);
              creditResults.push({
                learnerId,
                action: "refund",
                ok: resRef.ok,
              });
            } catch (e) {
              logger.error(
                { err: e, userId: learnerId, sessionId: updated.id },
                "[credits] refund failed on admin cancel"
              );
              creditResults.push({
                learnerId,
                action: "refund",
                ok: false,
              });
            }
          }
        }
      }

      await audit(req.user.id, "session_update", "Session", id, {
        ...patch,
        creditResults,
      });

      // Shape response
      const activeParticipants = (updated.participants || []).filter(
        (p) => p.status !== "canceled"
      );

      res.json({
        ...updated,
        participantCount: activeParticipants.length,
        learners:
          updated.type === "GROUP"
            ? activeParticipants.map((p) => ({ ...p.user, status: p.status }))
            : updated.user
            ? [{ ...updated.user, status: "booked" }]
            : [],
        creditResults,
      });
    } catch (err) {
      logger.error({ err }, "admin.sessions.patch error");
      res.status(500).json({ error: "Failed to update session" });
    }
  }
);

// --------------------------------------------------------------------------
// DELETE /api/admin/sessions/:id - Delete session
// --------------------------------------------------------------------------
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
