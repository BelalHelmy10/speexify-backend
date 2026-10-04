// src/routes/sessions/admin/previewRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  getRemainingCredits,
  logger,
} from "./shared.js";

const router = Router();

const DAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function normalizeSessionType(type) {
  return type === "GROUP" || type === "TRAINING" ? type : "ONE_ON_ONE";
}

function uniqueNumericIds(values) {
  return Array.from(
    new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )
  );
}

function parseSchedule(body) {
  const type = normalizeSessionType(body.type);
  const start = new Date(body.startAt);
  if (!body.startAt || Number.isNaN(start.getTime())) {
    return { error: "startAt is required" };
  }

  const end = body.endAt
    ? new Date(body.endAt)
    : new Date(start.getTime() + Number(body.durationMin || 60) * 60_000);

  if (Number.isNaN(end.getTime()) || end.getTime() <= start.getTime()) {
    return { error: "endAt must be after startAt" };
  }

  const learnerIds =
    type === "TRAINING"
      ? uniqueNumericIds([...(Array.isArray(body.learnerIds) ? body.learnerIds : []), ...(body.learnerId ? [body.learnerId] : [])])
      : type === "GROUP"
      ? uniqueNumericIds(body.learnerIds)
      : body.learnerId
        ? [Number(body.learnerId)]
        : [];

  if (type !== "TRAINING" && !learnerIds.length) {
    return {
      error:
        type === "GROUP"
          ? "learnerIds[] is required for GROUP sessions"
          : "learnerId is required",
    };
  }

  return {
    type,
    learnerIds,
    teacherIds: type === "TRAINING" ? uniqueNumericIds([...(Array.isArray(body.teacherIds) ? body.teacherIds : []), ...(body.teacherId ? [body.teacherId] : [])]) : [],
    teacherId: body.teacherId ? Number(body.teacherId) : (type === "TRAINING" ? Number(body.teacherIds?.[0]) || null : null),
    start,
    end,
    durationMin: Math.round((end.getTime() - start.getTime()) / 60_000),
    capacity:
      body.capacity === undefined || body.capacity === null || body.capacity === ""
        ? null
        : Number(body.capacity),
    title:
      String(body.title || "").trim() ||
      (type === "GROUP" ? "Group Session" : type === "TRAINING" ? "Training Session" : "Lesson"),
    joinUrl: String(body.joinUrl || body.meetingUrl || "").trim() || null,
    notes: String(body.notes || "").trim() || null,
    allowNoCredit: body.allowNoCredit === true || body.allowNoCredit === "true",
    allowNoCreditReason: String(
      body.allowNoCreditReason || body.creditOverrideReason || ""
    ).trim(),
  };
}

function safeTimeZone(timezone) {
  if (!timezone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return "UTC";
  }
}

function zonedParts(date, timezone) {
  const tz = safeTimeZone(timezone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(map.hour || 0);
  const minute = Number(map.minute || 0);

  return {
    timezone: tz,
    isoDate: `${map.year}-${map.month}-${map.day}`,
    dayOfWeek: DAY_INDEX[map.weekday] ?? date.getUTCDay(),
    minutes: hour * 60 + minute,
    label: `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`,
  };
}

function minutesFromTime(time) {
  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function shapeSlot(slot) {
  return {
    id: slot.id,
    dayOfWeek: slot.dayOfWeek,
    specificDate: slot.specificDate,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timezone: slot.timezone,
    isRecurring: slot.isRecurring,
    note: slot.note,
  };
}

function slotMatchesDate(slot, startParts) {
  if (slot.isRecurring) {
    return slot.dayOfWeek === startParts.dayOfWeek;
  }
  if (!slot.specificDate) return false;
  return slot.specificDate.toISOString().slice(0, 10) === startParts.isoDate;
}

function slotRelationToSession(slot, start, end, fallbackTimezone) {
  const timezone = safeTimeZone(slot.timezone || fallbackTimezone);
  const startParts = zonedParts(start, timezone);
  const endParts = zonedParts(end, timezone);
  const sameDay = startParts.isoDate === endParts.isoDate;

  if (!sameDay || !slotMatchesDate(slot, startParts)) {
    return { matchesDate: false, covers: false, overlaps: false, timezone };
  }

  const slotStart = minutesFromTime(slot.startTime);
  const slotEnd = minutesFromTime(slot.endTime);
  const covers = slotStart <= startParts.minutes && slotEnd >= endParts.minutes;
  const overlaps = slotStart < endParts.minutes && slotEnd > startParts.minutes;

  return {
    matchesDate: true,
    covers,
    overlaps,
    timezone,
    localStart: startParts.label,
    localEnd: endParts.label,
  };
}

async function getTeacherAvailabilityPreview({ teacher, start, end }) {
  if (!teacher) {
    return {
      status: "unassigned",
      label: "No teacher selected",
      message: "Choose a teacher to verify availability.",
      matchingSlots: [],
      sameDaySlots: [],
    };
  }

  const slots = await prisma.availability.findMany({
    where: { userId: teacher.id, status: "active" },
    orderBy: [
      { isRecurring: "desc" },
      { dayOfWeek: "asc" },
      { specificDate: "asc" },
      { startTime: "asc" },
    ],
  });

  if (!slots.length) {
    return {
      status: "not_set",
      label: "Availability not set",
      message: "This teacher has no active availability slots.",
      matchingSlots: [],
      sameDaySlots: [],
    };
  }

  const sameDaySlots = [];
  const matchingSlots = [];
  const overlappingSlots = [];

  for (const slot of slots) {
    const relation = slotRelationToSession(
      slot,
      start,
      end,
      teacher.timezone || "UTC"
    );

    if (!relation.matchesDate) continue;

    const shaped = { ...shapeSlot(slot), timezone: relation.timezone };
    sameDaySlots.push(shaped);
    if (relation.covers) matchingSlots.push(shaped);
    if (relation.overlaps) overlappingSlots.push(shaped);
  }

  if (matchingSlots.length) {
    return {
      status: "available",
      label: "Teacher available",
      message: "The selected time fits inside the teacher's availability.",
      matchingSlots,
      sameDaySlots,
    };
  }

  if (overlappingSlots.length) {
    return {
      status: "partial",
      label: "Partial availability",
      message:
        "The selected time overlaps availability but is not fully covered.",
      matchingSlots,
      sameDaySlots,
    };
  }

  return {
    status: "unavailable",
    label: "Outside availability",
    message: "No active availability slot covers this time.",
    matchingSlots,
    sameDaySlots,
  };
}

function shapeConflict(session) {
  return {
    id: session.id,
    title: session.title,
    startAt: session.startAt,
    endAt: session.endAt,
    type: session.type,
    status: session.status,
    userId: session.userId,
    teacherId: session.teacherId,
  };
}

async function getConflictPreview({ teacherId, learners, start, end }) {
  const [teacherConflicts, learnerConflictGroups] = await Promise.all([
    teacherId
      ? findSessionConflicts({ startAt: start, endAt: end, teacherId })
      : Promise.resolve([]),
    Promise.all(
      learners.map(async (learner) => ({
        learner,
        conflicts: (
          await findSessionConflicts({
            startAt: start,
            endAt: end,
            userId: learner.id,
          })
        ).map(shapeConflict),
      }))
    ),
  ]);

  const shapedTeacherConflicts = teacherConflicts.map(shapeConflict);
  const learnerConflicts = learnerConflictGroups.filter(
    (entry) => entry.conflicts.length > 0
  );

  return {
    total:
      shapedTeacherConflicts.length +
      learnerConflicts.reduce((sum, entry) => sum + entry.conflicts.length, 0),
    teacher: shapedTeacherConflicts,
    learners: learnerConflicts,
  };
}

async function getCreditPreview(learners, sessionType) {
  const rows = await Promise.all(
    learners.map(async (learner) => {
      const remaining = await getRemainingCredits(learner.id, prisma, sessionType);
      return {
        userId: learner.id,
        name: learner.name,
        email: learner.email,
        remaining,
        afterBooking: remaining > 0 ? remaining - 1 : remaining,
        hasCredit: remaining > 0,
      };
    })
  );

  return {
    requiredCredits: learners.length,
    requiresOverride: rows.some((row) => !row.hasCredit),
    learners: rows,
  };
}

function buildNotificationPreview({ learners, teacher, trainingTeachers = [], joinUrl, type }) {
  const recipients = [
    ...learners.map((learner) => ({
      role: "learner",
      userId: learner.id,
      name: learner.name,
      email: learner.email,
    })),
    ...(teacher
      ? [
          {
            role: "teacher",
            userId: teacher.id,
            name: teacher.name,
            email: teacher.email,
          },
        ]
      : []),
    ...trainingTeachers.map((person) => ({ role: "teacher", userId: person.id, name: person.name, email: person.email })),
  ].filter((person, index, all) => all.findIndex((other) => other.userId === person.userId) === index);

  return {
    willSend: recipients.length > 0,
    channels: ["email", "in-app"],
    meetingMode: joinUrl ? "External meeting link" : "Built-in classroom link",
    recipients,
    summary: [
      type === "TRAINING" ? `unpaid training with ${recipients.length} participant(s)` : `${learners.length} learner${learners.length === 1 ? "" : "s"}`,
      type === "TRAINING" ? "teachers and learners are welcome" : teacher ? "1 teacher" : "no teacher yet",
      joinUrl ? "external meeting URL included" : "built-in classroom will be used",
    ],
  };
}

router.post(
  "/admin/sessions/preview",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const schedule = parseSchedule(req.body || {});
      if (schedule.error) {
        return res.status(400).json({ error: schedule.error });
      }

      if (
        schedule.capacity !== null &&
        (!Number.isInteger(schedule.capacity) || schedule.capacity < 1)
      ) {
        return res.status(400).json({ error: "capacity must be a positive integer" });
      }

      if (
        schedule.type === "GROUP" &&
        schedule.capacity !== null &&
        schedule.learnerIds.length > schedule.capacity
      ) {
        return res.status(400).json({
          error: "capacity_exceeded",
          message: "learnerIds exceed session capacity",
        });
      }

      const [teacher, learners, trainingTeachers] = await Promise.all([
        schedule.teacherId
          ? prisma.user.findUnique({
              where: { id: schedule.teacherId },
              select: {
                id: true,
                email: true,
                name: true,
                role: true,
                timezone: true,
                isDisabled: true,
              },
            })
          : Promise.resolve(null),
        prisma.user.findMany({
          where: { id: { in: schedule.learnerIds } },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            timezone: true,
            isDisabled: true,
          },
        }),
        schedule.type === "TRAINING" ? prisma.user.findMany({ where: { id: { in: schedule.teacherIds } }, select: { id: true, email: true, name: true, role: true, timezone: true, isDisabled: true } }) : Promise.resolve([]),
      ]);

      const blockers = [];
      const warnings = [];

      if (schedule.type === "TRAINING" && !schedule.teacherIds.length && !schedule.learnerIds.length) {
        blockers.push("Choose at least one teacher or learner for training.");
      }
      if (schedule.type === "TRAINING" && schedule.capacity !== null) {
        blockers.push("Training cannot have capacity.");
      }
      if (schedule.type === "TRAINING") {
        const foundTeachers = new Set(trainingTeachers.map((person) => person.id));
        for (const id of schedule.teacherIds) {
          if (!foundTeachers.has(id)) blockers.push(`Teacher ${id} was not found.`);
        }
        for (const person of trainingTeachers) {
          if (person.role !== "teacher" || person.isDisabled) blockers.push(`${person.name || person.email} must be an active teacher.`);
        }
        if (schedule.teacherIds.some((id) => schedule.learnerIds.includes(id))) blockers.push("A person cannot be both teacher and learner.");
      }

      if (schedule.teacherId && !teacher) {
        blockers.push("Selected teacher was not found.");
      } else if (teacher?.isDisabled) {
        blockers.push("Selected teacher is disabled.");
      } else if (teacher && !["teacher", "admin"].includes(teacher.role)) {
        blockers.push("Selected teacher is not a teacher or admin.");
      }
      if (schedule.type === "TRAINING" && teacher && teacher.role !== "teacher") {
        blockers.push("Training must be assigned to a teacher.");
      }

      const foundLearnerIds = new Set(learners.map((learner) => learner.id));
      for (const learnerId of schedule.learnerIds) {
        if (!foundLearnerIds.has(learnerId)) {
          blockers.push(`Learner ${learnerId} was not found.`);
        }
      }

      for (const learner of learners) {
        if (learner.isDisabled) {
          blockers.push(`${learner.name || learner.email} is disabled.`);
        }
        if (schedule.type === "TRAINING" ? learner.role !== "learner" : !["learner", "admin"].includes(learner.role)) {
          blockers.push(`${learner.name || learner.email} is not a learner.`);
        }
      }

      if (schedule.type !== "TRAINING" && teacher && schedule.learnerIds.includes(teacher.id)) {
        blockers.push("Teacher cannot be a participant in the same session.");
      }

      const [availability, conflicts, credit] = await Promise.all([
        schedule.type === "TRAINING" && !teacher
          ? Promise.resolve({ status: "not_required", label: "No lead teacher", message: "Training can include learners without a teacher.", matchingSlots: [], sameDaySlots: [] })
          : getTeacherAvailabilityPreview({ teacher, start: schedule.start, end: schedule.end }),
        getConflictPreview({
          teacherId: schedule.teacherId,
          learners: schedule.type === "TRAINING" ? [...learners, ...trainingTeachers.filter((person) => person.id !== schedule.teacherId)] : learners,
          start: schedule.start,
          end: schedule.end,
        }),
        schedule.type === "TRAINING"
          ? Promise.resolve({ requiredCredits: 0, requiresOverride: false, learners: [] })
          : getCreditPreview(learners, schedule.type),
      ]);

      if (conflicts.total > 0) {
        blockers.push("The selected time conflicts with an existing session.");
      }
      if (schedule.type === "TRAINING") {
        const organizerConflicts = await findSessionConflicts({ startAt: schedule.start, endAt: schedule.end, userId: req.user.id });
        if (organizerConflicts.length) blockers.push("The admin trainer has another session at this time.");
      }

      if (credit.requiresOverride && !schedule.allowNoCredit) {
        blockers.push("One or more learners do not have enough credits.");
      }

      if (credit.requiresOverride && schedule.allowNoCredit) {
        if (schedule.allowNoCreditReason.length < 6) {
          blockers.push("No-credit override reason must be at least 6 characters.");
        } else {
          warnings.push("Credit override will be audited with the provided reason.");
        }
      }

      if (["not_set", "partial", "unavailable"].includes(availability.status)) {
        warnings.push(availability.message);
      }

      return res.json({
        ok: true,
        canCreate: blockers.length === 0,
        blockers,
        warnings,
        schedule: {
          type: schedule.type,
          title: schedule.title,
          startAt: schedule.start,
          endAt: schedule.end,
          durationMin: schedule.durationMin,
          capacity: schedule.capacity,
        },
        teacher,
        trainingTeachers,
        learners,
        timezones: {
          teacher: teacher?.timezone || null,
          learners: learners.map((learner) => ({
            userId: learner.id,
            name: learner.name,
            email: learner.email,
            timezone: learner.timezone || null,
          })),
        },
        availability,
        conflicts,
        credit,
        notifications: buildNotificationPreview({
          learners,
          teacher,
          trainingTeachers,
          joinUrl: schedule.joinUrl,
          type: schedule.type,
        }),
      });
    } catch (err) {
      logger.error({ err }, "admin.sessions.preview error");
      return res.status(500).json({ error: "Failed to preview session" });
    }
  }
);

export default router;
