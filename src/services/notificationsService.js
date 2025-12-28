// src/services/notificationsService.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { sendEmail } from "./emailService.js";

/**
 * Format date in user's timezone for email display
 */
function formatInTz(date, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "UTC",
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(date));
  } catch {
    return new Date(date).toISOString();
  }
}

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
}) {
  if (!userId || !type || !title) {
    throw new Error("createNotification: userId, type, and title are required");
  }

  const notif = await prisma.notification.create({
    data: {
      userId,
      type: String(type),
      title: String(title),
      body: body ? String(body) : null,
      data,
    },
  });

  logger.info(
    { userId, notificationId: notif.id, type: notif.type },
    "notification created"
  );

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

  try {
    const result = await prisma.notification.createMany({
      data: unique.map((uid) => ({
        userId: uid,
        type: String(type),
        title: String(title),
        body: body ? String(body) : null,
        data,
      })),
    });

    logger.info(
      { userIds: unique, type, count: result.count },
      "notifications created for multiple users"
    );

    return result;
  } catch (e) {
    logger.error(
      { err: e, userIds: unique, type },
      "Failed to create notifications for multiple users"
    );
    throw e;
  }
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
      select: { id: true, email: true, name: true, timezone: true },
    }),
    teacherId
      ? prisma.user.findUnique({
          where: { id: teacherId },
          select: { id: true, email: true, name: true, timezone: true },
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
      const when = formatInTz(session.startAt, learner.timezone);
      const join = session.joinUrl
        ? `<p><a href="${session.joinUrl}" style="display:inline-block;padding:12px 24px;background:#0066ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Join your classroom</a></p>`
        : "";

      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;">
          <h2 style="color:#1a1a1a;">🎉 Lesson Confirmed!</h2>
          <p>Hi${learner.name ? ` ${learner.name}` : ""},</p>
          <p>Great news! Your lesson has been successfully booked.</p>
          
          <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 8px;"><strong>📚 Session:</strong> ${sessionTitle}</p>
            <p style="margin:0 0 8px;"><strong>👨‍🏫 Teacher:</strong> ${teacherName}</p>
            <p style="margin:0;"><strong>📅 When:</strong> ${when}</p>
          </div>
          
          ${join}
          
          <p style="color:#666;font-size:14px;margin-top:30px;">
            You'll receive reminder emails before your session starts.
          </p>
          
          <p style="margin-top:30px;">— The Speexify Team</p>
        </div>
      `;

      try {
        await sendEmail(learner.email, `Speexify — Lesson Confirmed! 🎉`, html);
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
    const when = formatInTz(session.startAt, teacher.timezone);
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");
    const learnerCount = learners.length;

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;">
        <h2 style="color:#1a1a1a;">📅 New Lesson Booked</h2>
        <p>Hi${teacher.name ? ` ${teacher.name}` : ""},</p>
        <p>A new lesson has been scheduled with you.</p>
        
        <div style="background:#f8f9fa;border-radius:12px;padding:20px;margin:20px 0;">
          <p style="margin:0 0 8px;"><strong>📚 Session:</strong> ${sessionTitle}</p>
          <p style="margin:0 0 8px;"><strong>👨‍🎓 Learner${
            learnerCount > 1 ? "s" : ""
          }:</strong> ${learnerNames}</p>
          <p style="margin:0;"><strong>📅 When:</strong> ${when}</p>
        </div>
        
        ${
          session.joinUrl
            ? `<p><a href="${session.joinUrl}" style="display:inline-block;padding:12px 24px;background:#0066ff;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">View Session Details</a></p>`
            : ""
        }
        
        <p style="margin-top:30px;">— The Speexify Team</p>
      </div>
    `;

    try {
      await sendEmail(teacher.email, `Speexify — New Lesson Booked`, html);
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
      select: { id: true, email: true, name: true, timezone: true },
    }),
    teacherId
      ? prisma.user.findUnique({
          where: { id: teacherId },
          select: { id: true, email: true, name: true, timezone: true },
        })
      : null,
    canceledBy
      ? prisma.user.findUnique({
          where: { id: canceledBy },
          select: { id: true, name: true, role: true },
        })
      : null,
  ]);

  const cancelerName = canceler?.name || "Someone";
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
      const when = formatInTz(session.startAt, learner.timezone);
      const refundNote = refunded
        ? `<p style="color:#22c55e;font-weight:600;">✅ Your credit has been refunded.</p>`
        : "";

      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;">
          <h2 style="color:#dc2626;">❌ Session Canceled</h2>
          <p>Hi${learner.name ? ` ${learner.name}` : ""},</p>
          <p>Unfortunately, your session has been canceled.</p>
          
          <div style="background:#fef2f2;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #dc2626;">
            <p style="margin:0 0 8px;"><strong>📚 Session:</strong> ${sessionTitle}</p>
            <p style="margin:0;"><strong>📅 Was scheduled for:</strong> ${when}</p>
          </div>
          
          ${refundNote}
          
          <p>We apologize for any inconvenience. You can book a new session anytime from your dashboard.</p>
          
          <p style="margin-top:30px;">— The Speexify Team</p>
        </div>
      `;

      try {
        await sendEmail(learner.email, `Speexify — Session Canceled`, html);
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
    const when = formatInTz(session.startAt, teacher.timezone);
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");

    const cancelInfo =
      cancelerRole === "admin"
        ? "by an administrator"
        : cancelerRole === "learner"
        ? `by the learner`
        : "";

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;">
        <h2 style="color:#dc2626;">📅 Session Canceled</h2>
        <p>Hi${teacher.name ? ` ${teacher.name}` : ""},</p>
        <p>A session has been canceled${cancelInfo ? ` ${cancelInfo}` : ""}.</p>
        
        <div style="background:#fef2f2;border-radius:12px;padding:20px;margin:20px 0;border-left:4px solid #dc2626;">
          <p style="margin:0 0 8px;"><strong>📚 Session:</strong> ${sessionTitle}</p>
          <p style="margin:0 0 8px;"><strong>👨‍🎓 Learner(s):</strong> ${learnerNames}</p>
          <p style="margin:0;"><strong>📅 Was scheduled for:</strong> ${when}</p>
        </div>
        
        <p>Your schedule has been updated automatically.</p>
        
        <p style="margin-top:30px;">— The Speexify Team</p>
      </div>
    `;

    try {
      await sendEmail(teacher.email, `Speexify — Session Canceled`, html);
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
      select: { id: true, name: true, email: true },
    }),
    prisma.user.findMany({
      where: { id: { in: learnerIds } },
      select: { id: true, name: true, email: true, timezone: true },
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
      // Build feedback preview (truncate if too long)
      const messagePreview = feedback?.messageToLearner
        ? feedback.messageToLearner.length > 200
          ? feedback.messageToLearner.substring(0, 200) + "..."
          : feedback.messageToLearner
        : null;

      const feedbackSection = messagePreview
        ? `
          <div style="background:#f0fdf4;border-left:4px solid #22c55e;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-weight:600;color:#166534;">Message from ${teacherName}:</p>
            <p style="margin:0;color:#1a1a1a;font-style:italic;">"${messagePreview}"</p>
          </div>
        `
        : "";

      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;color:#1a1a1a;">
          <h2 style="margin-bottom:8px;">💬 New Feedback Received!</h2>
          
          <p>Hi${learner.name ? ` ${learner.name}` : ""},</p>
          
          <p>${teacherName} has left feedback for your session <strong>"${sessionTitle}"</strong>.</p>
          
          ${feedbackSection}
          
          <p>
            <a href="https://app.speexify.com/dashboard" 
               style="display:inline-block;padding:14px 28px;background:#0066ff;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
              View in Dashboard
            </a>
          </p>
          
          <p style="margin-top:16px;color:#64748b;font-size:13px;">
            Log in and go to your past sessions to view the full feedback.
          </p>
          
          <div style="margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;">
            <p style="color:#64748b;font-size:13px;margin:0;">
              💡 Reviewing feedback helps you track your progress and prepare for future sessions.
            </p>
          </div>
          
          <p style="margin-top:30px;color:#64748b;">— The Speexify Team</p>
        </div>
      `;

      try {
        await sendEmail(
          learner.email,
          `Speexify — ${teacherName} left you feedback! 💬`,
          html
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
