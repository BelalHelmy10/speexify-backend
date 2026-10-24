// src/services/notificationsService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { enqueueEmail } from "./emailService.js";
import {
  bookingLearnerEmail,
  bookingTeacherEmail,
  cancellationLearnerEmail,
  cancellationTeacherEmail,
  emailCopy,
  feedbackEmail,
  formatEmailDate,
  normalizeEmailLocale,
  sessionUpdatedLearnerEmail,
  sessionUpdatedTeacherEmail,
} from "./emailTemplates.js";
import { shouldDeliverInAppNotification } from "../lib/notificationPreferences.js";
import { publishNotificationEvent } from "./notificationStreamHub.js";

const REMINDER_TYPES = new Set(["reminder_24h", "reminder_6h", "reminder_1h"]);

async function notifyAdminSessionEvent({
  type,
  title,
  body,
  session,
  severity = "info",
  dedupeKey,
  email = "none",
  excludeAdminIds = [],
  extraData = {},
}) {
  try {
    // Dynamic import avoids a static cycle: admin alerts use this module's
    // createNotification primitive for durable bell delivery.
    const { ADMIN_ALERT_TYPES, notifyAdmins } = await import("./adminAlertsService.js");
    await notifyAdmins({
      type: ADMIN_ALERT_TYPES[type] || ADMIN_ALERT_TYPES.SESSION_ACTIVITY,
      title,
      body,
      severity,
      adminPath: `/admin?section=sessions&sessionId=${session.id}`,
      data: {
        sessionId: session.id,
        sessionType: session.type,
        startAt: session.startAt,
        teacherId: session.teacherId || null,
        ...extraData,
      },
      dedupeKey,
      dedupeWindowMs: null,
      email,
      excludeAdminIds,
    });
  } catch (error) {
    logger.error({ err: error, sessionId: session?.id }, "admin session alert failed");
  }
}

function escapeNotificationHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

async function sendTrainingEmail(recipient, session, subject, body) {
  const locale = normalizeEmailLocale(recipient.language);
  const when = formatEmailDate(session.startAt, recipient.timezone, locale);
  const details = session.joinUrl
    ? `<p>Meeting link: <a href="${escapeNotificationHtml(session.joinUrl)}">${escapeNotificationHtml(session.joinUrl)}</a></p>`
    : "<p>Open the session from your dashboard.</p>";
  await enqueueEmail(recipient.email, subject, `<p>Hello ${escapeNotificationHtml(recipient.name || "there")},</p><p>${escapeNotificationHtml(body)} <strong>${escapeNotificationHtml(session.title || "Training Session")}</strong> — ${escapeNotificationHtml(when)}.</p>${details}`, {
    userId: recipient.id, eventType: "training_session", sessionId: session.id, locale,
  });
}

/**
 * Skip duplicate reminder/session notifications within a short window.
 */
async function findRecentDuplicate(userId, type, data) {
  const sessionId = data?.sessionId;
  if (!sessionId) return null;

  const since = new Date(Date.now() - 2 * 60 * 60 * 1000);

  return prisma.notification.findFirst({
    where: {
      userId,
      type: String(type),
      createdAt: { gte: since },
      data: {
        path: ["sessionId"],
        equals: sessionId,
      },
    },
    orderBy: { id: "desc" },
  });
}

/**
 * Format date in user's timezone for email display
 */
/**
 * Create an in-app notification for a user.
 * Reusable across booking, payment, reminder, and cancellation flows.
 */
export async function createNotification({
  userId,
  type,
  title,
  body = null,
  data = null,
  skipPreferenceCheck = false,
  skipDedup = false,
}) {
  if (!userId || !type || !title) {
    throw new Error("createNotification: userId, type, and title are required");
  }

  const normalizedType = String(type);

  if (!skipPreferenceCheck) {
    const allowed = await shouldDeliverInAppNotification(userId, normalizedType);
    if (!allowed) {
      logger.info(
        { userId, type: normalizedType },
        "in-app notification skipped by user preferences"
      );
      return null;
    }
  }

  if (!skipDedup && REMINDER_TYPES.has(normalizedType)) {
    const duplicate = await findRecentDuplicate(userId, normalizedType, data);
    if (duplicate) {
      logger.info(
        { userId, type: normalizedType, existingId: duplicate.id },
        "in-app notification skipped as duplicate"
      );
      return duplicate;
    }
  }

  const notif = await prisma.notification.create({
    data: {
      userId,
      type: normalizedType,
      title: String(title),
      body: body ? String(body) : null,
      data,
    },
  });

  logger.info(
    { userId, notificationId: notif.id, type: notif.type },
    "notification created"
  );

  publishNotificationEvent(userId, {
    kind: "created",
    notification: notif,
    unreadDelta: 1,
  });

  return notif;
}

/**
 * Create notifications for multiple users at once.
 * More efficient than calling createNotification in a loop.
 */
export async function createNotificationsForMany(
  userIds,
  { type, title, body, data }
) {
  const unique = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!unique.length) return { count: 0 };

  const results = await Promise.all(
    unique.map((uid) =>
      createNotification({ userId: uid, type, title, body, data })
    )
  );

  const created = results.filter(Boolean);
  return { count: created.length };
}

/**
 * Send booking confirmation notification + email to learner(s) and teacher
 */
export async function sendBookingNotifications({
  session,
  learnerIds,
  teacherId,
  bookedBy = null,
}) {
  const sessionTitle = session.title || "Lesson";

  if (session.type === "TRAINING") {
    const participantIds = [...new Set([...(learnerIds || []), ...(teacherId ? [teacherId] : [])])];
    const [people, organizer] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: participantIds } }, select: { id: true, email: true, name: true, role: true, timezone: true, language: true } }),
      bookedBy ? prisma.user.findUnique({ where: { id: bookedBy }, select: { id: true, name: true, email: true, timezone: true, language: true } }) : null,
    ]);
    const organizerName = organizer?.name || organizer?.email || "an administrator";
    for (const person of people) {
      if (person.id === organizer?.id) continue;
      const sessionKind = person.role === "learner" ? "training session" : "unpaid training session";
      await createNotification({ userId: person.id, type: "new_booking", title: "Training scheduled", body: `Your ${sessionKind} "${sessionTitle}" with ${organizerName} has been scheduled.`, data: { sessionId: session.id, startAt: session.startAt, endAt: session.endAt, joinUrl: session.joinUrl, sessionType: session.type } });
      await sendTrainingEmail(person, session, "Training scheduled", `Your ${sessionKind} with ${organizerName} is scheduled:`);
    }
    if (organizer) {
      await createNotification({ userId: organizer.id, type: "new_booking", title: "Training scheduled", body: `You scheduled unpaid training "${sessionTitle}" with ${people.length} participant(s).`, data: { sessionId: session.id, startAt: session.startAt, endAt: session.endAt, sessionType: session.type } });
      await sendTrainingEmail(organizer, session, "Training scheduled", `You scheduled unpaid training with ${people.length} participant(s):`);
    }
    await notifyAdminSessionEvent({
      type: "SESSION_ACTIVITY",
      title: "Training session scheduled",
      body: `“${sessionTitle}” was scheduled with ${people.length} participant(s).`,
      session,
      dedupeKey: `session-booked:${session.id}`,
      excludeAdminIds: session.trainingAdminId ? [session.trainingAdminId] : [],
      extraData: { learnerIds: participantIds, bookedBy },
    });
    return;
  }

  // Fetch learner and teacher details for emails
  const [learners, teacher] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: learnerIds } },
      select: { id: true, email: true, name: true, timezone: true, language: true },
    }),
    teacherId
      ? prisma.user.findUnique({
          where: { id: teacherId },
          select: { id: true, email: true, name: true, timezone: true, language: true },
        })
      : null,
  ]);

  const teacherName = teacher?.name || "your teacher";

  // ─────────────────────────────────────────────────────────────────
  // In-app notifications
  // ─────────────────────────────────────────────────────────────────

  // Notify learners
  await Promise.all(
    learnerIds.map((uid) =>
      createNotification({
        userId: uid,
        type: "booking_confirmed",
        title: "Lesson booked",
        body: `Your lesson "${sessionTitle}" has been confirmed.`,
        data: {
          sessionId: session.id,
          startAt: session.startAt,
          endAt: session.endAt,
          joinUrl: session.joinUrl,
          sessionType: session.type,
          teacherId,
        },
      })
    )
  );

  // Notify teacher (if exists)
  if (teacherId) {
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");
    await createNotification({
      userId: teacherId,
      type: "new_booking",
      title: "New lesson booked",
      body: `A new lesson "${sessionTitle}" has been booked with ${learnerNames}.`,
      data: {
        sessionId: session.id,
        startAt: session.startAt,
        endAt: session.endAt,
        joinUrl: session.joinUrl,
        sessionType: session.type,
        learnerIds,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Email notifications
  // ─────────────────────────────────────────────────────────────────

  // Email to learners
  await Promise.all(
    learners.map(async (learner) => {
      const locale = normalizeEmailLocale(learner.language);
      const when = formatEmailDate(session.startAt, learner.timezone, locale);
      const content = bookingLearnerEmail({
        name: learner.name,
        sessionTitle,
        teacherName,
        when,
        joinUrl: session.joinUrl,
        locale,
      });

      try {
        await enqueueEmail(learner.email, content.subject, content.html, {
          userId: learner.id,
          eventType: "booking_confirmed",
          sessionId: session.id,
          locale,
        });
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id, learnerId: learner.id },
          "[notifications] failed to send booking email to learner"
        );
      }
    })
  );

  // Email to teacher
  if (teacher) {
    const locale = normalizeEmailLocale(teacher.language);
    const when = formatEmailDate(session.startAt, teacher.timezone, locale);
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");
    const learnerCount = learners.length;
    const content = bookingTeacherEmail({
      name: teacher.name,
      sessionTitle,
      learnerNames,
      learnerCount,
      when,
      joinUrl: session.joinUrl,
      locale,
    });

    try {
      await enqueueEmail(teacher.email, content.subject, content.html, {
        userId: teacher.id,
        eventType: "new_booking",
        sessionId: session.id,
        locale,
      });
    } catch (e) {
      logger.error(
        { err: e, sessionId: session.id, teacherId },
        "[notifications] failed to send booking email to teacher"
      );
    }
  }

  logger.info(
    { sessionId: session.id, learnerIds, teacherId },
    "Booking notifications sent"
  );
  await notifyAdminSessionEvent({
    type: teacher ? "SESSION_ACTIVITY" : "SESSION_ATTENTION",
    title: teacher ? "Session booked" : "Session booked without a teacher",
    body: `“${sessionTitle}” was booked for ${learners.length} learner(s)${teacher ? ` with ${teacher.name || teacher.email}` : " and needs a teacher"}.`,
    session,
    severity: teacher ? "info" : "warning",
    dedupeKey: `session-booked:${session.id}`,
    extraData: { learnerIds, bookedBy, needsTeacher: !teacher },
  });
}

/**
 * Send a schedule-change notification + email after a session time changes.
 * The old and new timestamps are kept in the in-app payload so clients can
 * explain exactly what changed without treating this as a new booking.
 */
export async function sendSessionUpdatedNotifications({
  session,
  previousStartAt,
  learnerIds,
  teacherId,
}) {
  const sessionTitle = session.title || "Session";
  const [learners, teacher] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: learnerIds } },
      select: { id: true, email: true, name: true, timezone: true, language: true },
    }),
    teacherId
      ? prisma.user.findUnique({
          where: { id: teacherId },
          select: { id: true, email: true, name: true, timezone: true, language: true },
        })
      : null,
  ]);

  if (session.type === "TRAINING") {
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set([...(learnerIds || []), ...(teacherId ? [teacherId] : [])])] } }, select: { id: true, email: true, name: true, role: true, timezone: true, language: true } });
    for (const person of people) {
      if (person.id === session.trainingAdminId) continue;
      const sessionKind = person.role === "learner" ? "training session" : "unpaid training session";
      await createNotification({ userId: person.id, type: "session_updated", title: "Training time updated", body: `Your ${sessionKind} "${sessionTitle}" has a new time.`, data: { sessionId: session.id, previousStartAt, startAt: session.startAt, endAt: session.endAt, sessionType: session.type } });
      await sendTrainingEmail(person, session, "Training time updated", `Your ${sessionKind} has a new time:`);
    }
    if (session.trainingAdminId) {
      const organizer = await prisma.user.findUnique({ where: { id: session.trainingAdminId }, select: { id: true, email: true, name: true, timezone: true, language: true } });
      if (organizer) {
        await createNotification({ userId: organizer.id, type: "session_updated", title: "Training time updated", body: `Training "${sessionTitle}" has a new time.`, data: { sessionId: session.id, previousStartAt, startAt: session.startAt, endAt: session.endAt, sessionType: session.type } });
        await sendTrainingEmail(organizer, session, "Training time updated", "Your teacher training has a new time:");
      }
    }
    await notifyAdminSessionEvent({
      type: "SESSION_ACTIVITY",
      title: "Training session rescheduled",
      body: `“${sessionTitle}” has a new scheduled time.`,
      session,
      dedupeKey: `session-updated:${session.id}:${new Date(session.startAt).toISOString()}`,
      excludeAdminIds: session.trainingAdminId ? [session.trainingAdminId] : [],
      extraData: { previousStartAt, learnerIds },
    });
    return;
  }

  const recipients = [...learnerIds, ...(teacherId ? [teacherId] : [])];
  await createNotificationsForMany(recipients, {
    type: "session_updated",
    title: "Session time updated",
    body: `The session "${sessionTitle}" is now scheduled for a new time.`,
    data: {
      sessionId: session.id,
      previousStartAt,
      startAt: session.startAt,
      endAt: session.endAt,
      joinUrl: session.joinUrl,
      sessionType: session.type,
      teacherId,
      learnerIds,
    },
  });

  await Promise.all(
    learners.map(async (learner) => {
      const locale = normalizeEmailLocale(learner.language);
      const previousWhen = formatEmailDate(previousStartAt, learner.timezone, locale);
      const when = formatEmailDate(session.startAt, learner.timezone, locale);
      const content = sessionUpdatedLearnerEmail({
        name: learner.name,
        sessionTitle,
        teacherName: teacher?.name || "your teacher",
        previousWhen,
        when,
        joinUrl: session.joinUrl,
        locale,
      });

      try {
        await enqueueEmail(learner.email, content.subject, content.html, {
          userId: learner.id,
          eventType: "session_updated",
          sessionId: session.id,
          locale,
        });
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id, learnerId: learner.id },
          "[notifications] failed to queue session update email to learner"
        );
      }
    })
  );

  if (teacher) {
    const locale = normalizeEmailLocale(teacher.language);
    const previousWhen = formatEmailDate(previousStartAt, teacher.timezone, locale);
    const when = formatEmailDate(session.startAt, teacher.timezone, locale);
    const content = sessionUpdatedTeacherEmail({
      name: teacher.name,
      sessionTitle,
      learnerNames: learners.map((learner) => learner.name || learner.email).join(", "),
      learnerCount: learners.length,
      previousWhen,
      when,
      joinUrl: session.joinUrl,
      locale,
    });

    try {
      await enqueueEmail(teacher.email, content.subject, content.html, {
        userId: teacher.id,
        eventType: "session_updated",
        sessionId: session.id,
        locale,
      });
    } catch (e) {
      logger.error(
        { err: e, sessionId: session.id, teacherId },
        "[notifications] failed to queue session update email to teacher"
      );
    }
  }

  logger.info(
    { sessionId: session.id, learnerIds, teacherId, previousStartAt, startAt: session.startAt },
    "Session update notifications queued"
  );
  await notifyAdminSessionEvent({
    type: "SESSION_ACTIVITY",
    title: "Session rescheduled",
    body: `“${sessionTitle}” has a new scheduled time.`,
    session,
    dedupeKey: `session-updated:${session.id}:${new Date(session.startAt).toISOString()}`,
    extraData: { previousStartAt, learnerIds },
  });
}

/**
 * Tell every affected person when an administrator changes the assigned
 * teacher without pretending that the session itself was newly booked.
 */
export async function sendTeacherAssignmentNotifications({
  session,
  learnerIds = [],
  previousTeacherId = null,
  teacherId = null,
  changedBy = null,
}) {
  const sessionTitle = session.title || "Session";
  const userIds = [...new Set([
    ...(learnerIds || []).map(Number).filter(Number.isFinite),
    ...(previousTeacherId ? [Number(previousTeacherId)] : []),
    ...(teacherId ? [Number(teacherId)] : []),
  ])];
  const people = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, name: true, role: true, timezone: true, language: true },
  });
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const nextTeacher = peopleById.get(Number(teacherId));
  const previousTeacher = peopleById.get(Number(previousTeacherId));
  const audienceIds = [...new Set((learnerIds || [])
    .map(Number)
    .filter((id) => Number.isFinite(id)
      && id !== Number(previousTeacherId)
      && id !== Number(teacherId)))];
  const learnerNames = audienceIds
    .map((id) => peopleById.get(Number(id)))
    .filter(Boolean)
    .map((learner) => learner.name || learner.email)
    .join(", ");
  const assignmentLabel = nextTeacher?.name || nextTeacher?.email || "a teacher";

  // Persist the administrative event independently of downstream recipient
  // delivery so a bad address or user-specific notification failure cannot
  // hide the reassignment from the rest of the admin team.
  await notifyAdminSessionEvent({
    type: teacherId ? "SESSION_ACTIVITY" : "SESSION_ATTENTION",
    title: teacherId ? "Session teacher changed" : "Session teacher removed",
    body: teacherId
      ? `“${sessionTitle}” is now assigned to ${assignmentLabel}.`
      : `“${sessionTitle}” no longer has an assigned teacher.`,
    session,
    severity: teacherId ? "info" : "warning",
    dedupeKey: `session-teacher:${session.id}:${teacherId || "unassigned"}`,
    excludeAdminIds: changedBy ? [changedBy] : [],
    extraData: { learnerIds, previousTeacherId, teacherId, changedBy, needsTeacher: !teacherId },
  });

  await Promise.all(audienceIds.map(async (learnerId) => {
    const learner = peopleById.get(Number(learnerId));
    if (!learner) return;
    await createNotification({
      userId: learner.id,
      type: "session_updated",
      title: "Session teacher updated",
      body: `“${sessionTitle}” is now assigned to ${assignmentLabel}.`,
      data: {
        sessionId: session.id,
        startAt: session.startAt,
        endAt: session.endAt,
        joinUrl: session.joinUrl,
        previousTeacherId,
        teacherId,
      },
    });
  }));

  if (previousTeacher && previousTeacher.id !== nextTeacher?.id) {
    await createNotification({
      userId: previousTeacher.id,
      type: "session_updated",
      title: "Session reassigned",
      body: `You are no longer assigned to “${sessionTitle}”.`,
      data: { sessionId: session.id, startAt: session.startAt, teacherId },
    });
  }

  if (nextTeacher && nextTeacher.id !== previousTeacher?.id) {
    await createNotification({
      userId: nextTeacher.id,
      type: "new_booking",
      title: "Session assigned to you",
      body: `You are now assigned to “${sessionTitle}”${learnerNames ? ` with ${learnerNames}` : ""}.`,
      data: {
        sessionId: session.id,
        startAt: session.startAt,
        endAt: session.endAt,
        joinUrl: session.joinUrl,
        learnerIds,
      },
    });
    const locale = normalizeEmailLocale(nextTeacher.language);
    const when = formatEmailDate(session.startAt, nextTeacher.timezone, locale);
    const content = bookingTeacherEmail({
      name: nextTeacher.name,
      sessionTitle,
      learnerNames,
      learnerCount: audienceIds.length,
      when,
      joinUrl: session.joinUrl,
      locale,
    });
    await enqueueEmail(nextTeacher.email, content.subject, content.html, {
      userId: nextTeacher.id,
      eventType: "session_teacher_assigned",
      sessionId: session.id,
      locale,
    });
  }

}

/**
 * Send cancellation notification + email to learner(s) and teacher
 */
export async function sendCancellationNotifications({
  session,
  learnerIds,
  teacherId,
  canceledBy,
  scope = "session", // "session" or "participant"
  refunded = false,
}) {
  const sessionTitle = session.title || "Session";

  // Fetch user details
  const [learners, teacher, canceler] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: learnerIds } },
      select: { id: true, email: true, name: true, timezone: true, language: true },
    }),
    teacherId
      ? prisma.user.findUnique({
          where: { id: teacherId },
          select: { id: true, email: true, name: true, timezone: true, language: true },
        })
      : null,
    canceledBy
      ? prisma.user.findUnique({
          where: { id: canceledBy },
          select: { id: true, name: true, role: true },
        })
      : null,
  ]);

  if (session.type === "TRAINING") {
    const people = await prisma.user.findMany({ where: { id: { in: [...new Set([...(learnerIds || []), ...(teacherId ? [teacherId] : [])])] } }, select: { id: true, email: true, name: true, role: true, timezone: true, language: true } });
    for (const person of people) {
      if (person.id === session.trainingAdminId) continue;
      const sessionKind = person.role === "learner" ? "training session" : "unpaid training session";
      await createNotification({ userId: person.id, type: "session_canceled", title: "Training canceled", body: `Your ${sessionKind} "${sessionTitle}" was canceled.`, data: { sessionId: session.id, startAt: session.startAt, sessionType: session.type } });
      if (canceledBy !== person.id) await sendTrainingEmail(person, session, "Training canceled", `Your ${sessionKind} was canceled:`);
    }
    if (session.trainingAdminId) {
      const organizer = await prisma.user.findUnique({ where: { id: session.trainingAdminId }, select: { id: true, email: true, name: true, timezone: true, language: true } });
      if (organizer) {
        await createNotification({ userId: organizer.id, type: "session_canceled", title: "Training canceled", body: `Training "${sessionTitle}" was canceled.`, data: { sessionId: session.id, startAt: session.startAt, sessionType: session.type } });
        if (canceledBy !== organizer.id) await sendTrainingEmail(organizer, session, "Teacher training canceled", "Your teacher training was canceled:");
      }
    }
    await notifyAdminSessionEvent({
      type: "SESSION_ATTENTION",
      title: scope === "participant" ? "Training participant canceled" : "Training session canceled",
      body: `“${sessionTitle}” was canceled${scope === "participant" ? " for one participant" : ""}.`,
      session,
      severity: "warning",
      dedupeKey: `session-canceled:${session.id}:${scope}:${scope === "participant" ? learnerIds.join("-") : "all"}`,
      email: canceler?.role === "admin" ? "none" : "critical",
      excludeAdminIds: session.trainingAdminId ? [session.trainingAdminId] : [],
      extraData: { canceledBy, scope, refunded, learnerIds },
    });
    return;
  }

  const cancelerRole = canceler?.role || "user";

  // Determine notification title based on scope
  const notifTitle =
    scope === "participant" ? "Seat canceled" : "Session canceled";
  const notifBody =
    scope === "participant"
      ? `A seat was canceled for "${sessionTitle}".`
      : `The session "${sessionTitle}" was canceled.`;

  // ─────────────────────────────────────────────────────────────────
  // In-app notifications
  // ─────────────────────────────────────────────────────────────────

  const recipients = [...learnerIds, ...(teacherId ? [teacherId] : [])];

  await createNotificationsForMany(recipients, {
    type: "session_canceled",
    title: notifTitle,
    body: notifBody,
    data: {
      scope,
      sessionId: session.id,
      canceledBy,
      startAt: session.startAt,
      refunded,
    },
  });

  // ─────────────────────────────────────────────────────────────────
  // Email notifications
  // ─────────────────────────────────────────────────────────────────

  // Email to learners
  await Promise.all(
    learners.map(async (learner) => {
      const locale = normalizeEmailLocale(learner.language);
      const when = formatEmailDate(session.startAt, learner.timezone, locale);
      const content = cancellationLearnerEmail({
        name: learner.name,
        sessionTitle,
        when,
        refunded,
        locale,
      });

      try {
        await enqueueEmail(learner.email, content.subject, content.html, {
          userId: learner.id,
          eventType: "session_canceled",
          sessionId: session.id,
          locale,
        });
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id, learnerId: learner.id },
          "[notifications] failed to send cancellation email to learner"
        );
      }
    })
  );

  // Email to teacher (if teacher didn't cancel)
  if (teacher && canceledBy !== teacherId) {
    const locale = normalizeEmailLocale(teacher.language);
    const when = formatEmailDate(session.startAt, teacher.timezone, locale);
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");

    const cancelInfo =
      cancelerRole === "admin"
        ? "by an administrator"
        : cancelerRole === "learner"
        ? `by the learner`
        : "";
    const localizedCancelInfo =
      cancelerRole === "admin"
        ? emailCopy(locale, "byAdmin")
        : cancelerRole === "learner"
        ? emailCopy(locale, "byLearner")
        : "";
    const content = cancellationTeacherEmail({
      name: teacher.name,
      sessionTitle,
      learnerNames,
      when,
      cancelInfo: localizedCancelInfo,
      locale,
    });

    try {
      await enqueueEmail(teacher.email, content.subject, content.html, {
        userId: teacher.id,
        eventType: "session_canceled",
        sessionId: session.id,
        locale,
      });
    } catch (e) {
      logger.error(
        { err: e, sessionId: session.id, teacherId },
        "[notifications] failed to send cancellation email to teacher"
      );
    }
  }

  logger.info(
    { sessionId: session.id, learnerIds, teacherId, scope },
    "Cancellation notifications sent"
  );
  await notifyAdminSessionEvent({
    type: "SESSION_ATTENTION",
    title: scope === "participant" ? "Learner canceled a session seat" : "Session canceled",
    body: `“${sessionTitle}” was canceled${refunded ? " and credits were refunded" : ""}.`,
    session,
    severity: "warning",
    dedupeKey: `session-canceled:${session.id}:${scope}:${scope === "participant" ? learnerIds.join("-") : "all"}`,
    email: cancelerRole === "admin" ? "none" : "critical",
    extraData: { canceledBy, cancelerRole, scope, refunded, learnerIds },
  });
}

/**
 * Send session completion notification (called after session is marked complete)
 */
export async function sendCompletionNotifications({
  session,
  learnerIds,
  teacherId,
}) {
  const sessionTitle = session.title || "Session";

  // Notify learners that feedback may be available
  await Promise.all(
    learnerIds.map((uid) =>
      createNotification({
        userId: uid,
        type: "session_completed",
        title: "Session completed",
        body: `Your session "${sessionTitle}" has been completed. Check for teacher feedback!`,
        data: {
          sessionId: session.id,
          startAt: session.startAt,
        },
      })
    )
  );

  logger.info(
    { sessionId: session.id, learnerIds },
    "Completion notifications sent"
  );
  await notifyAdminSessionEvent({
    type: "SESSION_ACTIVITY",
    title: "Session completed",
    body: `“${sessionTitle}” was completed; teacher feedback is now expected.`,
    session,
    severity: "success",
    dedupeKey: `session-completed:${session.id}`,
    extraData: { learnerIds, teacherId, needsFeedback: true },
  });
}

/**
 * Send notification + email when teacher leaves feedback
 */
export async function sendFeedbackNotifications({
  session,
  learnerIds,
  teacherId,
  feedback,
}) {
  const sessionTitle = session.title || "Session";

  // Fetch teacher and learners
  const [teacher, learners] = await Promise.all([
    prisma.user.findUnique({
      where: { id: teacherId },
      select: { id: true, name: true, email: true, language: true },
    }),
    prisma.user.findMany({
      where: { id: { in: learnerIds } },
      select: { id: true, name: true, email: true, timezone: true, language: true },
    }),
  ]);

  const teacherName = teacher?.name || "Your teacher";

  // ─────────────────────────────────────────────────────────────────
  // In-app notifications
  // ─────────────────────────────────────────────────────────────────

  await Promise.all(
    learnerIds.map((learnerId) =>
      createNotification({
        userId: learnerId,
        type: "feedback_received",
        title: "New feedback from your teacher",
        body: `${teacherName} left feedback for "${sessionTitle}".`,
        data: {
          sessionId: session.id,
          teacherId,
        },
      })
    )
  );

  // ─────────────────────────────────────────────────────────────────
  // Email notifications
  // ─────────────────────────────────────────────────────────────────

  await Promise.all(
    learners.map(async (learner) => {
      const locale = normalizeEmailLocale(learner.language);
      // Build feedback preview (truncate if too long)
      const messagePreview = feedback?.messageToLearner
        ? feedback.messageToLearner.length > 200
          ? feedback.messageToLearner.substring(0, 200) + "..."
          : feedback.messageToLearner
        : null;

      const content = feedbackEmail({
        name: learner.name,
        teacherName,
        sessionTitle,
        messagePreview,
        locale,
      });

      try {
        await enqueueEmail(
          learner.email,
          content.subject,
          content.html,
          {
            userId: learner.id,
            eventType: "feedback_received",
            sessionId: session.id,
            locale,
          }
        );
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id, learnerId: learner.id },
          "[notifications] failed to send feedback email to learner"
        );
      }
    })
  );

  logger.info(
    { sessionId: session.id, learnerIds, teacherId },
    "Feedback notifications sent"
  );
}
