// src/routes/sessions/admin/createRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCreditWithClient,
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

function httpError(statusCode, body) {
  const err = new Error(body?.message || body?.error || "Request failed");
  err.statusCode = statusCode;
  err.responseBody = body;
  return err;
}

function normalizeSessionType(type) {
  return type === "GROUP" ? "GROUP" : "ONE_ON_ONE";
}

function normalizeAllowNoCredit(value) {
  return value === true || value === "true";
}

function parseFinalCapacity(capacity) {
  if (capacity === undefined || capacity === null || capacity === "") return null;
  const parsed = Number(capacity);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw httpError(400, {
      error: "invalid_capacity",
      message: "capacity must be a positive integer",
    });
  }
  return parsed;
}

function uniqueLearnerIds(values) {
  return Array.from(
    new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

async function ensureTeacher(teacherId) {
  if (!teacherId) return null;

  const teacher = await prisma.user.findUnique({
    where: { id: Number(teacherId) },
    select: { id: true, role: true, isDisabled: true },
  });

  if (!teacher || teacher.isDisabled) {
    throw httpError(404, {
      error: "Teacher not found or disabled",
      teacherId: Number(teacherId),
    });
  }

  if (teacher.role !== "teacher" && teacher.role !== "admin") {
    throw httpError(400, {
      error: "teacherId must refer to a teacher or admin",
      teacherId: Number(teacherId),
      actualRole: teacher.role,
    });
  }

  return teacher;
}

async function ensureLearners(learnerIds) {
  const learners = await prisma.user.findMany({
    where: { id: { in: learnerIds } },
    select: { id: true, role: true, isDisabled: true },
  });
  const byId = new Map(learners.map((learner) => [learner.id, learner]));

  for (const learnerId of learnerIds) {
    const learner = byId.get(learnerId);
    if (!learner || learner.isDisabled) {
      throw httpError(404, {
        error: "User not found or disabled",
        learnerId,
      });
    }
    if (learner.role !== "learner" && learner.role !== "admin") {
      throw httpError(400, {
        error: "learnerIds must refer to learners",
        learnerId,
      });
    }
  }

  return learners;
}

async function ensureNoConflicts({ startAt, endAt, learnerIds, teacherId }) {
  const learnerChecks = await Promise.all(
    learnerIds.map(async (learnerId) => ({
      learnerId,
      conflicts: await findSessionConflicts({
        startAt,
        endAt,
        userId: learnerId,
      }),
    }))
  );

  for (const check of learnerChecks) {
    if (check.conflicts.length) {
      throw httpError(409, {
        error: "Time conflict",
        learnerId: check.learnerId,
        conflicts: check.conflicts,
      });
    }
  }

  if (teacherId) {
    const conflicts = await findSessionConflicts({
      startAt,
      endAt,
      teacherId: Number(teacherId),
    });

    if (conflicts.length) {
      throw httpError(409, {
        error: "Time conflict",
        teacherId: Number(teacherId),
        conflicts,
      });
    }
  }
}

async function ensureCredits({ learnerIds, allowNoCredit }) {
  if (allowNoCredit) return;

  for (const learnerId of learnerIds) {
    const remaining = await getRemainingCredits(learnerId);
    if (remaining <= 0) {
      throw httpError(422, {
        error: "no_credits",
        message: "Learner has no remaining credits",
        learnerId,
      });
    }
  }
}

async function consumeCreditsInTransaction({ tx, learnerIds, allowNoCredit }) {
  const creditResults = [];
  if (allowNoCredit) return creditResults;

  for (const learnerId of learnerIds) {
    const result = await consumeOneCreditWithClient(tx, learnerId);
    if (!result.ok) {
      throw httpError(422, {
        error: "no_credits",
        message: "Learner has no remaining credits",
        learnerId,
      });
    }
    creditResults.push({
      learnerId,
      consumed: true,
      packId: result.packId,
      remaining: result.remaining,
    });
  }

  return creditResults;
}

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
      allowNoCreditReason = "",
      creditOverrideReason = "",
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

    if (
      Number.isNaN(finalEndAt.getTime()) ||
      finalEndAt.getTime() <= start.getTime()
    ) {
      return res.status(400).json({ error: "endAt must be after startAt" });
    }

    const finalType = normalizeSessionType(type);
    const finalTeacherId = teacherId ? Number(teacherId) : null;
    const finalCapacity = parseFinalCapacity(capacity);
    const finalTitle =
      String(title || "").trim() ||
      (finalType === "GROUP" ? "Group Session" : "Lesson");
    const finalJoinUrl = (joinUrl ?? meetingUrl ?? "").trim() || null;
    const finalNotes = (notes ?? "").trim() || null;
    const allowCreditOverride = normalizeAllowNoCredit(allowNoCredit);
    const overrideReason = String(
      allowNoCreditReason || creditOverrideReason || ""
    ).trim();

    if (allowCreditOverride && overrideReason.length < 6) {
      return res.status(400).json({
        error: "credit_override_reason_required",
        message: "No-credit override reason must be at least 6 characters.",
      });
    }

    await ensureTeacher(finalTeacherId);

    const finalLearnerIds =
      finalType === "GROUP"
        ? uniqueLearnerIds(Array.isArray(learnerIds) ? learnerIds : [])
        : learnerId
          ? [Number(learnerId)]
          : [];

    if (!finalLearnerIds.length) {
      return res.status(400).json({
        error:
          finalType === "GROUP"
            ? "learnerIds[] is required for GROUP sessions"
            : "learnerId is required",
      });
    }

    if (finalLearnerIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: "Learner IDs must be valid" });
    }

    if (finalTeacherId && finalLearnerIds.includes(finalTeacherId)) {
      return res.status(400).json({
        error:
          finalType === "GROUP"
            ? "Teacher cannot be a participant in the same session"
            : "Teacher cannot be the same as learner",
        teacherId: finalTeacherId,
      });
    }

    if (
      finalType === "GROUP" &&
      finalCapacity !== null &&
      finalLearnerIds.length > finalCapacity
    ) {
      return res.status(400).json({
        error: "capacity_exceeded",
        message: "learnerIds exceed session capacity",
      });
    }

    await ensureLearners(finalLearnerIds);
    await ensureNoConflicts({
      startAt: start,
      endAt: finalEndAt,
      learnerIds: finalLearnerIds,
      teacherId: finalTeacherId,
    });
    await ensureCredits({
      learnerIds: finalLearnerIds,
      allowNoCredit: allowCreditOverride,
    });

    idempotency = await beginIdempotentRequest({
      actorId: req.user.id,
      scope: "admin.sessions.create",
      key: getIdempotencyKeyFromRequest(req),
      payload: {
        type: finalType,
        learnerIds: finalLearnerIds,
        teacherId: finalTeacherId,
        capacity: finalCapacity,
        title: finalTitle,
        startAt: start.toISOString(),
        endAt: finalEndAt.toISOString(),
        joinUrl: finalJoinUrl,
        notes: finalNotes,
        allowNoCredit: allowCreditOverride,
        allowNoCreditReason: allowCreditOverride ? overrideReason : null,
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

    const { session, creditResults } = await prisma.$transaction(async (tx) => {
      const createdSession = await tx.session.create({
        data: {
          type: finalType,
          userId: finalType === "ONE_ON_ONE" ? finalLearnerIds[0] : null,
          capacity: finalType === "GROUP" ? finalCapacity : null,
          teacherId: finalTeacherId,
          title: finalTitle,
          startAt: start,
          endAt: finalEndAt,
          joinUrl: finalJoinUrl,
          notes: finalNotes,
        },
      });

      if (finalType === "ONE_ON_ONE") {
        await tx.sessionParticipant.create({
          data: {
            sessionId: createdSession.id,
            userId: finalLearnerIds[0],
          },
        });
      } else {
        await tx.sessionParticipant.createMany({
          data: finalLearnerIds.map((id) => ({
            sessionId: createdSession.id,
            userId: id,
          })),
          skipDuplicates: true,
        });
      }

      const consumedCredits = await consumeCreditsInTransaction({
        tx,
        learnerIds: finalLearnerIds,
        allowNoCredit: allowCreditOverride,
      });

      return { session: createdSession, creditResults: consumedCredits };
    });

    await audit(req.user.id, "session_create", "Session", session.id, {
      type: finalType,
      learnerIds: finalLearnerIds,
      learnerId: finalType === "ONE_ON_ONE" ? finalLearnerIds[0] : undefined,
      teacherId: finalTeacherId,
      capacity: finalCapacity,
      creditResults,
      creditConsumed: creditResults.some((result) => result.consumed),
      creditOverrideAllowed: allowCreditOverride,
      creditOverrideReason: allowCreditOverride ? overrideReason : null,
    });

    try {
      await sendBookingNotifications({
        session,
        learnerIds: finalLearnerIds,
        teacherId: finalTeacherId,
        bookedBy: req.user.id,
      });
    } catch (e) {
      logger.error(
        { err: e, learnerIds: finalLearnerIds, sessionId: session.id },
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
  } catch (e) {
    if (idempotency?.state === "started") {
      await abandonIdempotentRequest(idempotency.recordId);
    }
    if (e?.statusCode && e?.responseBody) {
      return res.status(e.statusCode).json(e.responseBody);
    }
    logger.error({ err: e }, "admin.createSession error");
    return res.status(500).json({ error: "Failed to create session" });
  }
});

export default router;
