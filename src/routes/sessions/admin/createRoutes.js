// src/routes/sessions/admin/createRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCredit,
  sendBookingNotifications,
  logger,
  audit,
} from "./shared.js";
import {
  getIdempotencyKeyFromRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  abandonIdempotentRequest,
} from "../../../services/idempotencyService.js";

const router = Router();

// POST /api/admin/sessions - Create new session (1:1 or GROUP)
router.post("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  let idempotency = null;

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

    if (teacherId) {
      const teacher = await prisma.user.findUnique({
        where: { id: Number(teacherId) },
        select: { id: true, role: true, isDisabled: true },
      });

      if (!teacher || teacher.isDisabled) {
        return res.status(404).json({
          error: "Teacher not found or disabled",
          teacherId: Number(teacherId),
        });
      }

      if (teacher.role !== "teacher" && teacher.role !== "admin") {
        return res.status(400).json({
          error: "teacherId must refer to a teacher or admin",
          teacherId: Number(teacherId),
          actualRole: teacher.role,
        });
      }
    }

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

      if (teacherId && Number(teacherId) === Number(learnerId)) {
        return res.status(400).json({
          error: "Teacher cannot be the same as learner",
          teacherId: Number(teacherId),
          learnerId: Number(learnerId),
        });
      }

      const conflicts = await findSessionConflicts({
        startAt: start,
        endAt: finalEndAt,
        userId: Number(learnerId),
        teacherId,
      });

      if (conflicts.length) {
        return res.status(409).json({ error: "Time conflict", conflicts });
      }

      const remaining = await getRemainingCredits(Number(learnerId));
      if (!allowNoCredit && remaining <= 0) {
        return res.status(422).json({
          error: "no_credits",
          message: "Learner has no remaining credits",
          learnerId: Number(learnerId),
        });
      }

      idempotency = await beginIdempotentRequest({
        actorId: req.user.id,
        scope: "admin.sessions.create",
        key: getIdempotencyKeyFromRequest(req),
        payload: {
          type: "ONE_ON_ONE",
          learnerId: Number(learnerId),
          teacherId: teacherId ? Number(teacherId) : null,
          title,
          startAt: start.toISOString(),
          endAt: finalEndAt.toISOString(),
          joinUrl: finalJoinUrl,
          notes: finalNotes,
          allowNoCredit: !!allowNoCredit,
        },
      });

      if (idempotency.state === "replay") {
        return res.status(idempotency.statusCode).json(idempotency.responseBody);
      }
      if (
        idempotency.state === "conflict" ||
        idempotency.state === "in_progress" ||
        idempotency.state === "error"
      ) {
        return res.status(idempotency.statusCode).json(idempotency.responseBody);
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

      await prisma.sessionParticipant.create({
        data: {
          sessionId: session.id,
          userId: Number(learnerId),
        },
      });

      let creditResult = null;
      console.log("========== CREDIT DEBUG ==========");
      console.log("learnerId:", Number(learnerId));
      console.log("allowNoCredit:", allowNoCredit, "type:", typeof allowNoCredit);
      if (!allowNoCredit) {
        console.log(">>> ENTERING credit consumption");
        try {
          creditResult = await consumeOneCredit(Number(learnerId));
          console.log(">>> consumeOneCredit result:", JSON.stringify(creditResult));
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

      const responseBody = { ok: true, session };
      if (idempotency?.state === "started") {
        await completeIdempotentRequest(idempotency.recordId, {
          statusCode: 201,
          responseBody,
          resourceId: session.id,
        });
      }

      return res.status(201).json(responseBody);
    }

    if (!Array.isArray(learnerIds) || learnerIds.length === 0) {
      return res
        .status(400)
        .json({ error: "learnerIds[] is required for GROUP sessions" });
    }

    const uniqueLearnerIds = Array.from(
      new Set(learnerIds.map((x) => Number(x)).filter((n) => n && !Number.isNaN(n)))
    );

    if (!uniqueLearnerIds.length) {
      return res
        .status(400)
        .json({ error: "learnerIds[] must contain valid ids" });
    }

    if (teacherId && uniqueLearnerIds.includes(Number(teacherId))) {
      return res.status(400).json({
        error: "Teacher cannot be a participant in the same session",
        teacherId: Number(teacherId),
      });
    }

    if (capacity && uniqueLearnerIds.length > capacity) {
      return res.status(400).json({
        error: "capacity_exceeded",
        message: "learnerIds exceed session capacity",
      });
    }

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

    idempotency = await beginIdempotentRequest({
      actorId: req.user.id,
      scope: "admin.sessions.create",
      key: getIdempotencyKeyFromRequest(req),
      payload: {
        type: "GROUP",
        learnerIds: uniqueLearnerIds,
        teacherId: teacherId ? Number(teacherId) : null,
        capacity: capacity || null,
        title,
        startAt: start.toISOString(),
        endAt: finalEndAt.toISOString(),
        joinUrl: finalJoinUrl,
        notes: finalNotes,
        allowNoCredit: !!allowNoCredit,
      },
    });

    if (idempotency.state === "replay") {
      return res.status(idempotency.statusCode).json(idempotency.responseBody);
    }
    if (
      idempotency.state === "conflict" ||
      idempotency.state === "in_progress" ||
      idempotency.state === "error"
    ) {
      return res.status(idempotency.statusCode).json(idempotency.responseBody);
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
      },
    });

    await prisma.sessionParticipant.createMany({
      data: uniqueLearnerIds.map((uid) => ({
        sessionId: session.id,
        userId: uid,
      })),
      skipDuplicates: true,
    });

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

    const responseBody = { ok: true, session };
    if (idempotency?.state === "started") {
      await completeIdempotentRequest(idempotency.recordId, {
        statusCode: 201,
        responseBody,
        resourceId: session.id,
      });
    }

    return res.status(201).json(responseBody);
  } catch (e) {
    if (idempotency?.state === "started") {
      await abandonIdempotentRequest(idempotency.recordId);
    }
    logger.error({ err: e }, "admin.createSession error");
    return res.status(500).json({ error: "Failed to create session" });
  }
});

export default router;
