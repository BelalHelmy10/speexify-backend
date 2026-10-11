import crypto from "node:crypto";
import os from "node:os";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import {
  acquireDistributedLock,
  releaseDistributedLock,
} from "./distributedLockService.js";
import {
  ADMIN_ALERT_TYPES,
  notifyAdmins,
} from "./adminAlertsService.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function cairoClock(now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return {
    dateKey: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour") || 0),
  };
}

function money(amountMinor, currency = "EGP") {
  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
    }).format(Number(amountMinor || 0) / 100);
  } catch {
    return `${(Number(amountMinor || 0) / 100).toFixed(2)} ${currency}`;
  }
}

async function alertOverdueSupport({ db, now, deliver }) {
  const tickets = await db.supportTicket.findMany({
    where: { slaDueAt: { lt: now }, status: { not: "RESOLVED" } },
    orderBy: { slaDueAt: "asc" },
    take: 100,
    select: {
      id: true,
      priority: true,
      slaDueAt: true,
      userId: true,
      assignedToId: true,
      subject: true,
      user: { select: { name: true, email: true } },
    },
  });
  for (const ticket of tickets) {
    await deliver({
      type: ADMIN_ALERT_TYPES.SUPPORT_SLA,
      title: "Support SLA overdue",
      body: `Ticket #${ticket.id} for ${ticket.user?.name || ticket.user?.email || "a learner"} is overdue${ticket.subject ? `: ${ticket.subject}` : "."}`,
      severity: "critical",
      adminPath: `/admin/support?ticket=${ticket.id}`,
      data: { ticketId: ticket.id, userId: ticket.userId, priority: ticket.priority, slaDueAt: ticket.slaDueAt },
      dedupeKey: `support-sla:${ticket.id}:${ticket.slaDueAt?.toISOString?.() || "unknown"}`,
      dedupeWindowMs: null,
      email: "critical",
      mandatory: true,
      targetAdminIds: ticket.assignedToId ? [ticket.assignedToId] : null,
    });
  }
  return tickets.length;
}

async function alertSessionAttention({ db, now, deliver }) {
  const nextDay = new Date(now.getTime() + DAY_MS);
  const missingFeedbackBefore = new Date(now.getTime() - 12 * HOUR_MS);
  const [unassigned, missingFeedback] = await Promise.all([
    db.session.findMany({
      where: {
        status: "scheduled",
        type: { not: "TRAINING" },
        teacherId: null,
        startAt: { gt: now, lte: nextDay },
      },
      orderBy: { startAt: "asc" },
      take: 100,
      select: { id: true, title: true, type: true, startAt: true },
    }),
    db.session.findMany({
      where: {
        status: "completed",
        type: { not: "TRAINING" },
        feedbackScore: null,
        completedAt: { lte: missingFeedbackBefore },
      },
      orderBy: { completedAt: "asc" },
      take: 100,
      select: { id: true, title: true, teacherId: true, completedAt: true },
    }),
  ]);

  for (const session of unassigned) {
    const hoursUntil = Math.max(0, Math.round((session.startAt.getTime() - now.getTime()) / HOUR_MS));
    const urgent = hoursUntil <= 6;
    await deliver({
      type: ADMIN_ALERT_TYPES.SESSION_ATTENTION,
      title: urgent ? "Session starts soon without a teacher" : "Session needs a teacher",
      body: `“${session.title}” starts in about ${hoursUntil} hour(s) and is still unassigned.`,
      severity: urgent ? "critical" : "warning",
      adminPath: `/admin?section=sessions&sessionId=${session.id}`,
      data: { sessionId: session.id, startAt: session.startAt, needsTeacher: true },
      dedupeKey: `session-needs-teacher:${session.id}:${urgent ? "urgent" : "day"}`,
      dedupeWindowMs: null,
      email: urgent ? "critical" : "none",
      mandatory: urgent,
    });
  }

  for (const session of missingFeedback) {
    const overdueHours = Math.max(12, Math.round((now.getTime() - session.completedAt.getTime()) / HOUR_MS));
    const urgent = overdueHours >= 24;
    await deliver({
      type: ADMIN_ALERT_TYPES.SESSION_ATTENTION,
      title: "Completed session is missing feedback",
      body: `“${session.title}” has been complete for ${overdueHours} hour(s) without teacher feedback.`,
      severity: urgent ? "critical" : "warning",
      adminPath: `/admin?section=sessions&sessionId=${session.id}`,
      data: { sessionId: session.id, teacherId: session.teacherId, completedAt: session.completedAt, needsFeedback: true },
      dedupeKey: `session-needs-feedback:${session.id}:${urgent ? "urgent" : "initial"}`,
      dedupeWindowMs: null,
      email: urgent ? "critical" : "none",
    });
  }
  return unassigned.length + missingFeedback.length;
}

async function alertPaymentAttention({ db, now, deliver }) {
  const staleBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const recentAfter = new Date(now.getTime() - 7 * DAY_MS);
  const orders = await db.order.findMany({
    where: {
      status: "pending",
      updatedAt: { gte: recentAfter, lte: staleBefore },
    },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: {
      id: true,
      userId: true,
      packageId: true,
      amountCents: true,
      currency: true,
      updatedAt: true,
      user: { select: { name: true, email: true } },
      package: { select: { title: true } },
    },
  });
  for (const order of orders) {
    await deliver({
      type: ADMIN_ALERT_TYPES.PAYMENT_ATTENTION,
      title: "Payment has remained pending",
      body: `${order.user?.name || order.user?.email || `Learner #${order.userId}`} has a ${money(order.amountCents, order.currency)} payment for ${order.package?.title || "a package"} pending for more than 15 minutes.`,
      severity: "warning",
      adminPath: `/admin?section=payments&orderId=${encodeURIComponent(order.id)}`,
      data: { orderId: order.id, userId: order.userId, packageId: order.packageId, updatedAt: order.updatedAt },
      dedupeKey: `payment-stale:${order.id}:${order.updatedAt.toISOString()}`,
      dedupeWindowMs: null,
      email: "critical",
    });
  }
  return orders.length;
}

async function alertPackageAttention({ db, now, deliver }) {
  const expiresBefore = new Date(now.getTime() + 7 * DAY_MS);
  const select = {
      id: true,
      userId: true,
      title: true,
      sessionsTotal: true,
      sessionsUsed: true,
      expiresAt: true,
      user: { select: { name: true, email: true } },
  };
  const [expiring, depletedCandidates] = await Promise.all([
    db.userPackage.findMany({
      where: { status: "active", expiresAt: { gt: now, lte: expiresBefore } },
      orderBy: { expiresAt: "asc" },
      select,
    }),
    db.userPackage.findMany({
      where: {
        status: "active",
        ...(db.userPackage.fields?.sessionsTotal
          ? { sessionsUsed: { gte: db.userPackage.fields.sessionsTotal } }
          : {}),
      },
      orderBy: { updatedAt: "asc" },
      select,
    }),
  ]);
  const attentionById = new Map(expiring.map((item) => [item.id, item]));
  for (const item of depletedCandidates) {
    if (Number(item.sessionsUsed) >= Number(item.sessionsTotal)) {
      attentionById.set(item.id, item);
    }
  }
  const attention = [...attentionById.values()];

  for (const item of attention) {
    const depleted = Number(item.sessionsUsed) >= Number(item.sessionsTotal);
    await deliver({
      type: ADMIN_ALERT_TYPES.CREDIT_ATTENTION,
      title: depleted ? "Learner has no credits remaining" : "Learner package expires soon",
      body: depleted
        ? `${item.user?.name || item.user?.email || `Learner #${item.userId}`} has used every credit in ${item.title}.`
        : `${item.user?.name || item.user?.email || `Learner #${item.userId}`} still has ${Math.max(0, item.sessionsTotal - item.sessionsUsed)} credit(s) in ${item.title}, which expires within 7 days.`,
      severity: "warning",
      adminPath: `/admin/registrations/${item.userId}`,
      data: { userPackageId: item.id, userId: item.userId, expiresAt: item.expiresAt, depleted },
      dedupeKey: depleted
        ? `package-depleted:${item.id}`
        : `package-expiring:${item.id}:${item.expiresAt?.toISOString?.() || "unknown"}`,
      dedupeWindowMs: null,
    });
  }
  return attention.length;
}

async function alertPayrollFailures({ db, deliver }) {
  const jobs = await db.teacherEarningSnapshotJob.findMany({
    where: { status: "FAILED" },
    orderBy: { updatedAt: "asc" },
    take: 100,
    select: { id: true, sessionId: true, teacherId: true, attempts: true, lastError: true, updatedAt: true },
  });
  for (const job of jobs) {
    await deliver({
      type: ADMIN_ALERT_TYPES.PAYROLL,
      title: "Teacher earning snapshot failed",
      body: `Session #${job.sessionId} has not produced a reliable teacher earning after ${job.attempts} attempt(s).`,
      severity: "critical",
      adminPath: "/admin?section=teacher-earnings",
      data: { jobId: job.id, sessionId: job.sessionId, teacherId: job.teacherId },
      dedupeKey: `payroll-snapshot-failed:${job.id}:${job.attempts}`,
      dedupeWindowMs: null,
      email: "critical",
      mandatory: true,
    });
  }
  return jobs.length;
}

async function sendDailyDigest({ db, now, deliver }) {
  const clock = cairoClock(now);
  if (clock.hour < 8) return 0;
  const since = new Date(now.getTime() - DAY_MS);
  const expiresBefore = new Date(now.getTime() + 7 * DAY_MS);
  const [paidOrders, newUsers, createdSessions, completedSessions, canceledSessions, activeSupport, assessments, pendingEarnings, expiringPackages] = await Promise.all([
    db.order.count({ where: { status: "paid", updatedAt: { gte: since } } }),
    db.user.count({ where: { role: "learner", createdAt: { gte: since } } }),
    db.session.count({ where: { createdAt: { gte: since } } }),
    db.session.count({ where: { status: "completed", completedAt: { gte: since } } }),
    db.session.count({ where: { status: "canceled", updatedAt: { gte: since } } }),
    db.supportTicket.count({ where: { status: { not: "RESOLVED" } } }),
    db.assessmentSubmission.count({ where: { status: { in: ["submitted", "auto_scored", "awaiting_review"] } } }),
    db.teacherEarning.aggregate({ where: { status: "PENDING" }, _sum: { amountMinor: true }, _count: { _all: true } }),
    db.userPackage.count({ where: { status: "active", expiresAt: { gt: now, lte: expiresBefore } } }),
  ]);
  const body = [
    `${paidOrders} payment(s)`,
    `${newUsers} new learner(s)`,
    `${createdSessions} session(s) created`,
    `${completedSessions} completed`,
    `${canceledSessions} canceled`,
    `${activeSupport} active support ticket(s)`,
    `${assessments} assessment(s) awaiting review`,
    `${pendingEarnings._count._all} pending earning(s) totaling ${money(pendingEarnings._sum.amountMinor || 0)}`,
    `${expiringPackages} package(s) expiring within 7 days`,
  ].join(" · ");

  await deliver({
    type: ADMIN_ALERT_TYPES.DAILY_DIGEST,
    title: `Daily operations digest · ${clock.dateKey}`,
    body,
    severity: "info",
    adminPath: "/admin",
    data: {
      date: clock.dateKey,
      paidOrders,
      newUsers,
      createdSessions,
      completedSessions,
      canceledSessions,
      activeSupport,
      assessments,
      pendingEarningsCount: pendingEarnings._count._all,
      pendingEarningsMinor: pendingEarnings._sum.amountMinor || 0,
      expiringPackages,
    },
    dedupeKey: `admin-digest:${clock.dateKey}`,
    dedupeWindowMs: null,
    email: "always",
  });
  return 1;
}

export async function runAdminAlertSweep({
  now = new Date(),
  db = prisma,
  deliver = notifyAdmins,
} = {}) {
  const counts = {};
  const checks = [
    ["support", () => alertOverdueSupport({ db, now, deliver })],
    ["sessions", () => alertSessionAttention({ db, now, deliver })],
    ["payments", () => alertPaymentAttention({ db, now, deliver })],
    ["packages", () => alertPackageAttention({ db, now, deliver })],
    ["payroll", () => alertPayrollFailures({ db, deliver })],
    ["digest", () => sendDailyDigest({ db, now, deliver })],
  ];
  for (const [name, check] of checks) {
    try {
      counts[name] = await check();
    } catch (error) {
      counts[name] = 0;
      logger.error({ err: error, check: name }, "admin operational alert check failed");
    }
  }
  return counts;
}

export function startAdminAlertScheduler({
  intervalMs = Number(process.env.ADMIN_ALERT_INTERVAL_MS || 5 * 60 * 1000),
  lockName = "admin-operational-alerts",
  lockLeaseMs = Number(process.env.ADMIN_ALERT_LOCK_LEASE_MS || 4 * 60 * 1000),
  ownerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`,
} = {}) {
  const safeIntervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5 * 60 * 1000;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    const token = crypto.randomUUID();
    let acquired = false;
    try {
      const lock = await acquireDistributedLock({ lockName, ownerId, token, leaseMs: lockLeaseMs });
      acquired = lock.acquired;
      if (!acquired) return;
      const counts = await runAdminAlertSweep();
      if (Object.values(counts).some(Boolean)) {
        logger.info({ counts }, "admin operational alert sweep completed");
      }
    } catch (error) {
      logger.error({ err: error }, "admin operational alert sweep failed");
    } finally {
      if (acquired) await releaseDistributedLock({ lockName, ownerId, token });
      running = false;
    }
  }

  void tick();
  const handle = setInterval(tick, safeIntervalMs);
  if (typeof handle.unref === "function") handle.unref();
  logger.info({ intervalMs: safeIntervalMs, ownerId }, "admin operational alert scheduler started");
  return () => clearInterval(handle);
}
