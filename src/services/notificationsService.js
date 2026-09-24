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
} from "./emailTemplates.js";
import { shouldDeliverInAppNotification } from "../lib/notificationPreferences.js";
import { publishNotificationEvent } from "./notificationStreamHub.js";

const REMINDER_TYPES = new Set(["reminder_24h", "reminder_6h", "reminder_1h"]);

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
