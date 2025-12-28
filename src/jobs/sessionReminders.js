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
        select: { id: true, name: true },
      })
    : null;

  // Build reminder text
  const titleMap = {
    "24h": "Session reminder (tomorrow)",
    "6h": "Session reminder (today)",
    "1h": "Session starting soon",
  };

  const notifTypeMap = {
    "24h": "reminder_24h",
    "6h": "reminder_6h",
    "1h": "reminder_1h",
  };

  const title = titleMap[kind] || "Session reminder";
  const notifType = notifTypeMap[kind] || "reminder";

  // In-app notifications
  // - Learners: always
  // - Teacher: also (since you want both)
  const recipients = [...learnerIds, ...(teacherId ? [teacherId] : [])];

  await Promise.all(
    recipients.map((uid) =>
      createNotification({
        userId: uid,
        type: notifType,
        title,
        body: session.title || "Upcoming session",
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

  // Email (learners only)
  await Promise.all(
    learners.map(async (learner) => {
      const when = formatInTz(session.startAt, learner.timezone);
      const teacherName = teacher?.name ? ` with ${teacher.name}` : "";
      const join = session.joinUrl
        ? `<p><a href="${session.joinUrl}">Join your classroom</a></p>`
        : "";

      const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.5">
          <h2>${title}</h2>
          <p>Hi${learner.name ? ` ${learner.name}` : ""},</p>
          <p>This is a reminder for your session${teacherName}.</p>
          <p><b>When:</b> ${when}</p>
          ${join}
          <p>— Speexify</p>
        </div>
      `;

      try {
        await sendEmail(learner.email, `Speexify — ${title}`, html);
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id, learnerId: learner.id },
          "[reminders] failed to send email"
        );
      }
    })
  );
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
