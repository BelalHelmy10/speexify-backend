// src/jobs/sessionReminders.js
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import os from "os";
import crypto from "crypto";
import { createNotification } from "../services/notificationsService.js";
import { enqueueEmail } from "../services/emailService.js";
import {
  formatEmailDate,
  formatEmailTimeUntil,
  normalizeEmailLocale,
  reminderEmail,
} from "../services/emailTemplates.js";
import {
  acquireDistributedLock,
  renewDistributedLock,
  releaseDistributedLock,
} from "../services/distributedLockService.js";

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
    select: { id: true, email: true, name: true, timezone: true, language: true },
  });

  const teacher = teacherId
    ? await prisma.user.findUnique({
        where: { id: teacherId },
        select: { id: true, name: true, email: true, timezone: true, language: true },
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

  const title = titleMap[kind] || "Session reminder";
  const notifType = notifTypeMap[kind] || "reminder";
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
      const locale = normalizeEmailLocale(learner.language);
      const when = formatEmailDate(session.startAt, learner.timezone, locale);
      const teacherName = teacher?.name ? teacher.name : "your teacher";
      const timeUntil = formatEmailTimeUntil(session.startAt, locale);
      const content = reminderEmail({
        role: "learner",
        kind,
        name: learner.name,
        sessionTitle,
        teacherName,
        when,
        timeUntil,
        joinUrl: session.joinUrl,
        locale,
      });

      try {
        await enqueueEmail(learner.email, content.subject, content.html, {
          userId: learner.id,
          eventType: `reminder_${kind}`,
          sessionId: session.id,
          locale,
        });
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
    const locale = normalizeEmailLocale(teacher.language);
    const when = formatEmailDate(session.startAt, teacher.timezone, locale);
    const timeUntil = formatEmailTimeUntil(session.startAt, locale);
    const learnerNames = learners.map((l) => l.name || l.email).join(", ");
    const learnerCount = learners.length;

    const content = reminderEmail({
      role: "teacher",
      kind,
      name: teacher.name,
      sessionTitle,
      learnerNames,
      learnerCount,
      when,
      timeUntil,
      joinUrl: session.joinUrl,
      locale,
    });

    try {
      await enqueueEmail(teacher.email, content.subject, content.html, {
        userId: teacher.id,
        eventType: `reminder_${kind}`,
        sessionId: session.id,
        locale,
      });
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
  lockName = "session-reminders-scheduler",
  lockLeaseMs = Math.max(intervalMs * 4, 10 * 60 * 1000),
  lockOwnerId = process.env.SCHEDULER_OWNER_ID ||
    `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`,
} = {}) {
  logger.info(
    { intervalMs, windowMinutes, lockName, lockLeaseMs, lockOwnerId },
    "[reminders] scheduler starting"
  );

  let inProcessTickRunning = false;

  const tick = async () => {
    if (inProcessTickRunning) {
      logger.warn("[reminders] previous tick still running, skipping overlap");
      return;
    }

    inProcessTickRunning = true;
    const lockToken = crypto.randomUUID();
    const renewEveryMs = Math.max(10_000, Math.floor(lockLeaseMs / 3));
    let renewalHandle = null;
    let lockLost = false;
    let lock = null;

    try {
      lock = await acquireDistributedLock({
        lockName,
        ownerId: lockOwnerId,
        token: lockToken,
        leaseMs: lockLeaseMs,
      });

      if (!lock.acquired) {
        logger.debug(
          { lockName, lockOwnerId },
          "[reminders] distributed lock held by another worker, skipping tick"
        );
        return;
      }

      renewalHandle = setInterval(() => {
        renewDistributedLock({
          lockName,
          ownerId: lockOwnerId,
          token: lockToken,
          leaseMs: lockLeaseMs,
        })
          .then((renewed) => {
            if (!renewed) {
              lockLost = true;
              logger.error(
                { lockName, lockOwnerId },
                "[reminders] lock renewal failed; stopping current tick early"
              );
            }
          })
          .catch((err) => {
            lockLost = true;
            logger.error(
              { err, lockName, lockOwnerId },
              "[reminders] lock renewal error; stopping current tick early"
            );
          });
      }, renewEveryMs);

      const now = new Date();

      // Targets: 24h, 6h, 1h from now
      const targets = [
        { kind: "24h", hours: 24, field: "reminder24hSentAt" },
        { kind: "6h", hours: 6, field: "reminder6hSentAt" },
        { kind: "1h", hours: 1, field: "reminder1hSentAt" },
      ];

      for (const t of targets) {
        if (lockLost) break;

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
          if (lockLost) break;

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
    } finally {
      if (renewalHandle) {
        clearInterval(renewalHandle);
      }

      if (lock?.acquired) {
        await releaseDistributedLock({
          lockName,
          ownerId: lockOwnerId,
          token: lockToken,
        });
      }

      inProcessTickRunning = false;
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
