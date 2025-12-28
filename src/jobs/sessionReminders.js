// src/jobs/sessionReminders.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { createNotification } from "../services/notificationsService.js";
import { sendEmail } from "../services/emailService.js";

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

function getTimeUntilSession(startAt) {
  const now = new Date();
  const start = new Date(startAt);
  const diffMs = start.getTime() - now.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffMins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

  if (diffHours > 24) {
    const days = Math.floor(diffHours / 24);
    return `${days} day${days > 1 ? "s" : ""}`;
  }
  if (diffHours > 0) {
    return `${diffHours} hour${diffHours > 1 ? "s" : ""}`;
  }
  return `${diffMins} minute${diffMins > 1 ? "s" : ""}`;
}

async function getLearnerIdsForSession(session) {
  // Prefer participants (works for GROUP and future-proof for 1:1)
  if (session.participants?.length) {
    return session.participants
      .filter((p) => p.status !== "canceled")
      .map((p) => p.userId);
  }
  // Legacy 1:1
  return session.userId ? [session.userId] : [];
}

async function sendReminderForSession({ session, kind }) {
  const teacherId = session.teacherId || null;
  const learnerIds = await getLearnerIdsForSession(session);

  if (!learnerIds.length) return;

  // Fetch learners for email + timezone formatting
  const learners = await prisma.user.findMany({
    where: { id: { in: learnerIds } },
    select: { id: true, email: true, name: true, timezone: true },
  });

  const teacher = teacherId
    ? await prisma.user.findUnique({
        where: { id: teacherId },
        select: { id: true, name: true, email: true, timezone: true },
      })
    : null;

  // Build reminder text
  const titleMap = {
    "24h": "Session reminder (tomorrow)",
    "6h": "Session reminder (today)",
    "1h": "Session starting soon!",
  };

  const notifTypeMap = {
    "24h": "reminder_24h",
    "6h": "reminder_6h",
    "1h": "reminder_1h",
  };

  const emojiMap = {
    "24h": "📅",
    "6h": "⏰",
    "1h": "🚨",
  };

  const title = titleMap[kind] || "Session reminder";
  const notifType = notifTypeMap[kind] || "reminder";
  const emoji = emojiMap[kind] || "🔔";
  const sessionTitle = session.title || "Upcoming session";

  // ─────────────────────────────────────────────────────────────────
  // In-app notifications
  // ─────────────────────────────────────────────────────────────────

  // Notify learners
  await Promise.all(
    learnerIds.map((uid) =>
      createNotification({
        userId: uid,
        type: notifType,
        title,
        body: sessionTitle,
        data: {
          sessionId: session.id,
          startAt: session.startAt,
          endAt: session.endAt,
          joinUrl: session.joinUrl,
          teacherId: teacherId,
        },
      })
    )
  );

  // Notify teacher
  if (teacherId) {
    await createNotification({
      userId: teacherId,
      type: notifType,
      title,
      body: sessionTitle,
      data: {
        sessionId: session.id,
        startAt: session.startAt,
        endAt: session.endAt,
        joinUrl: session.joinUrl,
        learnerIds,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Email notifications to learners
  // ─────────────────────────────────────────────────────────────────

  await Promise.all(
    learners.map(async (learner) => {
      const when = formatInTz(session.startAt, learner.timezone);
      const teacherName = teacher?.name ? teacher.name : "your teacher";
      const timeUntil = getTimeUntilSession(session.startAt);

      const joinButton = session.joinUrl
        ? `
          <p style="margin: 24px 0;">
            <a href="${session.joinUrl}" 
               style="display:inline-block;padding:14px 28px;background:#0066ff;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
              Join Classroom Now
            </a>
          </p>
        `
        : "";

      const urgencyStyle =
        kind === "1h"
          ? "background:#fef3c7;border-left:4px solid #f59e0b;"
          : "background:#f8f9fa;border-left:4px solid #0066ff;";

      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;color:#1a1a1a;">
          <h2 style="margin-bottom:8px;">${emoji} ${title}</h2>
          
          <p>Hi${learner.name ? ` ${learner.name}` : ""},</p>
          
          <p>Your session is coming up in <strong>${timeUntil}</strong>!</p>
          
          <div style="${urgencyStyle}border-radius:12px;padding:20px;margin:20px 0;">
            <p style="margin:0 0 10px;font-size:16px;"><strong>📚 ${sessionTitle}</strong></p>
            <p style="margin:0 0 8px;color:#4a5568;"><strong>👨‍🏫 Teacher:</strong> ${teacherName}</p>
            <p style="margin:0;color:#4a5568;"><strong>📅 When:</strong> ${when}</p>
          </div>
          
          ${joinButton}
          
          <div style="margin-top:30px;padding-top:20px;border-top:1px solid #e2e8f0;">
            <p style="color:#64748b;font-size:13px;margin:0;">
              ${
                kind === "1h"
                  ? "⚡ Your session starts very soon. Please be ready!"
                  : "💡 Make sure to prepare any questions or materials before the session."
              }
            </p>
          </div>
          
          <p style="margin-top:30px;color:#64748b;">— The Speexify Team</p>
        </div>
      `;

      try {
        await sendEmail(learner.email, `Speexify — ${title}`, html);
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id, learnerId: learner.id },
          "[reminders] failed to send email to learner"
        );
      }
    })
  );

  // ─────────────────────────────────────────────────────────────────
  // Email notification to teacher
  // ─────────────────────────────────────────────────────────────────

  if (teacher) {
    const when = formatInTz(session.startAt, teacher.timezone);
    const timeUntil = getTimeUntilSession(session.startAt);
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");
    const learnerCount = learners.length;

    const joinButton = session.joinUrl
      ? `
        <p style="margin: 24px 0;">
          <a href="${session.joinUrl}" 
             style="display:inline-block;padding:14px 28px;background:#0066ff;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
            Start Session
          </a>
        </p>
      `
      : "";

    const urgencyStyle =
      kind === "1h"
        ? "background:#fef3c7;border-left:4px solid #f59e0b;"
        : "background:#f8f9fa;border-left:4px solid #0066ff;";

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:600px;margin:0 auto;color:#1a1a1a;">
        <h2 style="margin-bottom:8px;">${emoji} ${title}</h2>
        
        <p>Hi${teacher.name ? ` ${teacher.name}` : ""},</p>
        
        <p>Your session is coming up in <strong>${timeUntil}</strong>!</p>
        
        <div style="${urgencyStyle}border-radius:12px;padding:20px;margin:20px 0;">
          <p style="margin:0 0 10px;font-size:16px;"><strong>📚 ${sessionTitle}</strong></p>
          <p style="margin:0 0 8px;color:#4a5568;"><strong>👨‍🎓 Learner${
            learnerCount > 1 ? "s" : ""
          }:</strong> ${learnerNames}</p>
          <p style="margin:0;color:#4a5568;"><strong>📅 When:</strong> ${when}</p>
        </div>
        
        ${joinButton}
        
        <p style="margin-top:30px;color:#64748b;">— The Speexify Team</p>
      </div>
    `;

    try {
      await sendEmail(teacher.email, `Speexify — ${title}`, html);
    } catch (e) {
      logger.error(
        { err: e, sessionId: session.id, teacherId: teacher.id },
        "[reminders] failed to send email to teacher"
      );
    }
  }
}

export function startSessionReminderScheduler({
  intervalMs = 5 * 60 * 1000, // every 5 minutes
  windowMinutes = 6, // match sessions starting within next ~6 minutes of target
} = {}) {
  logger.info({ intervalMs, windowMinutes }, "[reminders] scheduler starting");

  const tick = async () => {
    const now = new Date();

    // Targets: 24h, 6h, 1h from now
    const targets = [
      { kind: "24h", hours: 24, field: "reminder24hSentAt" },
      { kind: "6h", hours: 6, field: "reminder6hSentAt" },
      { kind: "1h", hours: 1, field: "reminder1hSentAt" },
    ];

    for (const t of targets) {
      const target = new Date(now.getTime() + t.hours * 60 * 60 * 1000);
      const start = new Date(target.getTime() - windowMinutes * 60 * 1000);
      const end = new Date(target.getTime() + windowMinutes * 60 * 1000);

      const where = {
        status: "scheduled",
        startAt: { gte: start, lt: end },
        [t.field]: null,
      };

      const sessions = await prisma.session.findMany({
        where,
        select: {
          id: true,
          title: true,
          startAt: true,
          endAt: true,
          status: true,
          userId: true,
          teacherId: true,
          joinUrl: true,
          participants: {
            select: { userId: true, status: true },
          },
        },
        orderBy: { startAt: "asc" },
        take: 200,
      });

      if (!sessions.length) continue;

      logger.info(
        { count: sessions.length, kind: t.kind },
        "[reminders] sessions found"
      );

      for (const session of sessions) {
        try {
          await sendReminderForSession({ session, kind: t.kind });

          // Mark this reminder as sent so it never repeats
          await prisma.session.update({
            where: { id: session.id },
            data: { [t.field]: new Date() },
          });
        } catch (e) {
          logger.error(
            { err: e, sessionId: session.id, kind: t.kind },
            "[reminders] failed to process session reminder"
          );
        }
      }
    }
  };

  // Run once immediately, then on interval
  tick().catch((e) =>
    logger.error({ err: e }, "[reminders] initial tick failed")
  );

  const handle = setInterval(() => {
    tick().catch((e) => logger.error({ err: e }, "[reminders] tick failed"));
  }, intervalMs);

  return () => clearInterval(handle);
}
