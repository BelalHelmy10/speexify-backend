// Create recurring weekly sessions for one learner or a group of learners.

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflictsWithClient,
  lockSchedulingResources,
  getRemainingCredits,
  consumeOneCreditWithClient,
  sendBookingNotifications,
  audit,
  logger,
} from "./_shared.js";
import {
  getIdempotencyKeyFromRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  abandonIdempotentRequest,
} from "../../services/idempotencyService.js";

const bulkCreateRouter = Router();
const SESSION_TYPES = new Set(["ONE_ON_ONE", "GROUP"]);

function httpError(statusCode, body) {
  const error = new Error(body?.message || body?.error || "Request failed");
  error.statusCode = statusCode;
  error.responseBody = body;
  return error;
}

function normalizeType(value) {
  const type = String(value || "ONE_ON_ONE").trim().toUpperCase();
  if (!SESSION_TYPES.has(type)) {
    throw httpError(400, {
      error: "invalid_session_type",
      message: "type must be ONE_ON_ONE or GROUP",
    });
  }
  return type;
}

function normalizeAllowNoCredit(value) {
  return value === true || value === "true";
}

function parseInteger(value, { field, min, max, fallback = null }) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== null) return fallback;
    throw httpError(400, { error: `${field}_required`, message: `${field} is required` });
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw httpError(400, {
      error: `invalid_${field}`,
      message: `${field} must be an integer between ${min} and ${max}`,
    });
  }
  return parsed;
}

function uniqueIds(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [values])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function parseStartDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    throw httpError(400, {
      error: "invalid_start_date",
      message: "startDate must be a valid YYYY-MM-DD date",
    });
  }

  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw httpError(400, {
      error: "invalid_start_date",
      message: "startDate must be a valid calendar date",
    });
  }
  return date;
}

function nextDateForDay(dayOfWeek) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  while (date.getDay() !== dayOfWeek) {
    date.setDate(date.getDate() + 1);
  }
  return date;
}

function parseTime(value) {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(String(value || ""));
  if (!match) {
    throw httpError(400, {
      error: "invalid_time",
      message: "time must be in HH:MM format",
    });
  }
  return String(value);
}

function buildSessionDates(startDate, numberOfSessions, time, durationMin) {
  const [hours, minutes] = time.split(":").map(Number);
  const dates = [];
  let currentDate = new Date(startDate);

  for (let index = 0; index < numberOfSessions; index += 1) {
    const startAt = new Date(currentDate);
    startAt.setHours(hours, minutes, 0, 0);

    const endAt = new Date(startAt);
    endAt.setMinutes(endAt.getMinutes() + durationMin);

    dates.push({ startAt, endAt });
    currentDate.setDate(currentDate.getDate() + 7);
  }

  return dates;
}

async function ensureTeacher(teacherId) {
  if (!teacherId) return;

  const teacher = await prisma.user.findUnique({
    where: { id: Number(teacherId) },
    select: { id: true, role: true, isDisabled: true },
  });

  if (!teacher || teacher.isDisabled) {
    throw httpError(404, { error: "teacher_not_found", message: "Teacher not found or disabled" });
  }
  if (teacher.role !== "teacher" && teacher.role !== "admin") {
    throw httpError(400, { error: "invalid_teacher", message: "Selected user is not a teacher" });
  }
}

async function ensureLearners(learnerIds) {
  const learners = await prisma.user.findMany({
    where: { id: { in: learnerIds } },
    select: { id: true, email: true, name: true, role: true, isDisabled: true },
  });
  const byId = new Map(learners.map((learner) => [learner.id, learner]));

  for (const learnerId of learnerIds) {
    const learner = byId.get(learnerId);
    if (!learner || learner.isDisabled) {
      throw httpError(404, {
        error: "learner_not_found",
        message: "One or more selected learners were not found or are disabled",
        learnerId,
      });
    }
    if (learner.role !== "learner" && learner.role !== "admin") {
      throw httpError(400, {
        error: "invalid_learner",
        message: "All selected participants must be learners",
        learnerId,
      });
    }
  }

  return learners;
}

async function ensureNoConflicts({ db, startAt, endAt, learnerIds, teacherId }) {
  const learnerChecks = await Promise.all(
    learnerIds.map(async (learnerId) => ({
      learnerId,
      conflicts: await findSessionConflictsWithClient(db, {
        userId: learnerId,
        startAt,
        endAt,
      }),
    }))
  );

  const teacherConflicts = teacherId
    ? await findSessionConflictsWithClient(db, { teacherId, startAt, endAt })
    : [];

  const learnerConflicts = learnerChecks.filter((entry) => entry.conflicts.length);
  if (!learnerConflicts.length && !teacherConflicts.length) return;

  throw httpError(409, {
    error: "time_conflict",
    message: "One or more requested sessions overlap an existing session",
    conflicts: [
      ...learnerConflicts.flatMap((entry) =>
        entry.conflicts.map((conflict) => ({ ...conflict, learnerId: entry.learnerId }))
      ),
      ...teacherConflicts.map((conflict) => ({ ...conflict, teacherId })),
    ],
  });
}

/**
 * POST /api/admin/sessions/bulk-create
 *
 * Creates weekly recurring sessions. ONE_ON_ONE accepts learnerId; GROUP
 * accepts learnerIds and creates a participant row plus one credit debit for
 * every learner on every session.
 */
bulkCreateRouter.post(
  "/admin/sessions/bulk-create",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    let idempotency = null;

    try {
      const {
        type = "ONE_ON_ONE",
        learnerId,
        learnerIds,
        teacherId,
        capacity,
        dayOfWeek,
        time,
        numberOfSessions,
        durationMin = 60,
        defaultTitle = "Lesson",
        customTitles = [],
        allowNoCredit = false,
        allowNoCreditReason = "",
        startDate,
      } = req.body || {};

      const finalType = normalizeType(type);
      const finalDayOfWeek = parseInteger(dayOfWeek, {
        field: "dayOfWeek",
        min: 0,
        max: 6,
      });
      const finalTime = parseTime(time);
      const finalNumberOfSessions = parseInteger(numberOfSessions, {
        field: "numberOfSessions",
        min: 1,
        max: 52,
      });
      const finalDurationMin = parseInteger(durationMin, {
        field: "durationMin",
        min: 15,
        max: 240,
        fallback: 60,
      });
      const finalStartDate = startDate
        ? parseStartDate(startDate)
        : nextDateForDay(finalDayOfWeek);
      const finalTeacherId = teacherId ? Number(teacherId) : null;
      if (finalTeacherId !== null && (!Number.isInteger(finalTeacherId) || finalTeacherId <= 0)) {
        throw httpError(400, {
          error: "invalid_teacher_id",
          message: "teacherId must be a valid user id",
        });
      }
      const finalLearnerIds = uniqueIds(
        finalType === "GROUP" ? learnerIds : learnerId
      );

      if (finalType === "ONE_ON_ONE" && finalLearnerIds.length !== 1) {
        throw httpError(400, {
          error: "learner_id_required",
          message: "A 1:1 schedule requires exactly one learner",
        });
      }
      if (finalType === "GROUP" && finalLearnerIds.length < 2) {
        throw httpError(400, {
          error: "group_participants_required",
          message: "A group schedule requires at least two learners",
        });
      }
      if (finalTeacherId && finalLearnerIds.includes(finalTeacherId)) {
        throw httpError(400, {
          error: "teacher_is_participant",
          message: "Teacher cannot be a participant in the same session",
        });
      }

      let finalCapacity = null;
      if (finalType === "GROUP") {
        finalCapacity = parseInteger(capacity, {
          field: "capacity",
          min: 2,
          max: 100,
          fallback: Math.max(6, finalLearnerIds.length),
        });
        if (finalLearnerIds.length > finalCapacity) {
          throw httpError(400, {
            error: "capacity_exceeded",
            message: "Selected learners exceed the group capacity",
            capacity: finalCapacity,
            participantCount: finalLearnerIds.length,
          });
        }
      }

      const creditOverride = normalizeAllowNoCredit(allowNoCredit);
      const overrideReason = String(allowNoCreditReason || "").trim();
      if (creditOverride && overrideReason.length < 6) {
        throw httpError(400, {
          error: "credit_override_reason_required",
          message: "A no-credit override reason must be at least 6 characters",
        });
      }

      await ensureTeacher(finalTeacherId);
      const learners = await ensureLearners(finalLearnerIds);
      const sessionDates = buildSessionDates(
        finalStartDate,
        finalNumberOfSessions,
        finalTime,
        finalDurationMin
      );
      const titles = Array.isArray(customTitles) ? customTitles : [];

      idempotency = await beginIdempotentRequest({
        actorId: req.user.id,
        scope: "admin.sessions.bulkCreate",
        key: getIdempotencyKeyFromRequest(req),
        payload: {
          type: finalType,
          learnerIds: finalLearnerIds,
          teacherId: finalTeacherId,
          capacity: finalCapacity,
          dayOfWeek: finalDayOfWeek,
          time: finalTime,
          numberOfSessions: finalNumberOfSessions,
          durationMin: finalDurationMin,
          defaultTitle,
          customTitles: titles,
          allowNoCredit: creditOverride,
          allowNoCreditReason: creditOverride ? overrideReason : null,
          startDate: startDate || null,
        },
      });

      if (idempotency.state === "replay") {
        return res.status(idempotency.statusCode).json(idempotency.responseBody);
      }
      if (["conflict", "in_progress", "error"].includes(idempotency.state)) {
        return res.status(idempotency.statusCode).json(idempotency.responseBody);
      }

      const { createdSessions, creditResults } = await prisma.$transaction(async (tx) => {
        await lockSchedulingResources(tx, {
          learnerIds: finalLearnerIds,
          teacherId: finalTeacherId,
        });

        const results = [];
        const consumedCredits = [];

        for (let index = 0; index < sessionDates.length; index += 1) {
          const { startAt, endAt } = sessionDates[index];
          await ensureNoConflicts({
            db: tx,
            startAt,
            endAt,
            learnerIds: finalLearnerIds,
            teacherId: finalTeacherId,
          });

          const session = await tx.session.create({
            data: {
              type: finalType,
              userId: finalType === "ONE_ON_ONE" ? finalLearnerIds[0] : null,
              capacity: finalCapacity,
              teacherId: finalTeacherId,
              title: String(titles[index] || defaultTitle || "Lesson").trim() || "Lesson",
              startAt,
              endAt,
              status: "scheduled",
            },
            include: {
              user: { select: { id: true, name: true, email: true } },
              teacher: { select: { id: true, name: true, email: true } },
            },
          });

          await tx.sessionParticipant.createMany({
            data: finalLearnerIds.map((userId) => ({
              sessionId: session.id,
              userId,
              status: "booked",
            })),
            skipDuplicates: true,
          });

          if (!creditOverride) {
            for (const userId of finalLearnerIds) {
              const debit = await consumeOneCreditWithClient(tx, userId, session.id);
              if (!debit.ok) {
                const creditsAvailable = await getRemainingCredits(
                  userId,
                  tx,
                  finalType
                );
                throw httpError(422, {
                  error: "insufficient_credits",
                  message: "One or more learners do not have enough credits",
                  learnerId: userId,
                  creditsAvailable,
                  sessionsRequested: finalNumberOfSessions,
                });
              }
              consumedCredits.push({
                learnerId: userId,
                sessionId: session.id,
                packId: debit.packId,
              });
            }
          }

          results.push(session);
        }

        return { createdSessions: results, creditResults: consumedCredits };
      });

      await audit(req.user.id, "session_bulk_create", "Session", createdSessions[0]?.id, {
        type: finalType,
        learnerIds: finalLearnerIds,
        teacherId: finalTeacherId,
        capacity: finalCapacity,
        created: createdSessions.length,
        creditResults,
        creditOverride,
        creditOverrideReason: creditOverride ? overrideReason : null,
      });

      for (const session of createdSessions) {
        try {
          await sendBookingNotifications({
            session,
            learnerIds: finalLearnerIds,
            teacherId: session.teacherId || null,
            bookedBy: req.user.id,
          });
        } catch (error) {
          logger.error(
            { err: error, sessionId: session.id },
            "Failed to send bulk booking notifications"
          );
        }
      }

      const creditsAfterByLearner = await Promise.all(
        learners.map(async (learner) => ({
          learnerId: learner.id,
          name: learner.name,
          email: learner.email,
          remaining: await getRemainingCredits(learner.id, prisma, finalType),
        }))
      );
      const creditsConsumed = creditOverride
        ? 0
        : finalLearnerIds.length * createdSessions.length;
      const responseBody = {
        success: true,
        type: finalType,
        created: createdSessions.length,
        participantCount: finalLearnerIds.length,
        creditsConsumed,
        creditsAfter:
          finalType === "ONE_ON_ONE"
            ? creditsAfterByLearner[0]?.remaining ?? null
            : null,
        creditsAfterByLearner,
        sessions: createdSessions.map((session) => ({
          id: session.id,
          date: session.startAt.toISOString().split("T")[0],
          startAt: session.startAt.toISOString(),
          endAt: session.endAt?.toISOString() || null,
          title: session.title,
          type: session.type,
          participantCount: finalLearnerIds.length,
        })),
      };

      if (idempotency?.state === "started") {
        await completeIdempotentRequest(idempotency.recordId, {
          statusCode: 201,
          responseBody,
          resourceId: createdSessions[0]?.id || null,
        });
      }

      return res.status(201).json(responseBody);
    } catch (error) {
      if (idempotency?.state === "started") {
        await abandonIdempotentRequest(idempotency.recordId);
      }
      logger.error({ err: error }, "bulk-create recurring sessions error");
      if (error?.statusCode && error?.responseBody) {
        return res.status(error.statusCode).json(error.responseBody);
      }
      return res.status(500).json({
        error: "Failed to create sessions",
        message: error.message,
        details: process.env.NODE_ENV === "development" ? error.stack : undefined,
      });
    }
  }
);

export default bulkCreateRouter;
