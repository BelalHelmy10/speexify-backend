import test from "node:test";
import assert from "node:assert/strict";
import { runAdminAlertSweep } from "../../src/services/adminAlertScheduler.js";
import { ADMIN_ALERT_TYPES } from "../../src/services/adminAlertsService.js";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "../../src/lib/notificationPreferences.js";

const NOW = new Date("2026-10-12T06:00:00.000Z");

function emptyDb(overrides = {}) {
  return {
    supportTicket: { findMany: async () => [], count: async () => 0 },
    session: { findMany: async () => [], count: async () => 0 },
    order: { findMany: async () => [], count: async () => 0 },
    user: { count: async () => 0 },
    assessmentSubmission: { count: async () => 0 },
    teacherEarning: {
      aggregate: async () => ({ _sum: { amountMinor: null }, _count: { _all: 0 } }),
    },
    teacherEarningSnapshotJob: { findMany: async () => [] },
    userPackage: { findMany: async () => [], count: async () => 0 },
    ...overrides,
  };
}

test("admin alert sweep covers action queues and sends one daily digest", async () => {
  const alerts = [];
  let sessionQuery = 0;
  let packageQuery = 0;
  const db = emptyDb({
    supportTicket: {
      findMany: async () => [{
        id: 11,
        userId: 20,
        assignedToId: 2,
        priority: "URGENT",
        subject: "Cannot join",
        slaDueAt: new Date("2026-10-12T05:00:00.000Z"),
        user: { name: "Sara" },
      }],
      count: async () => 6,
    },
    session: {
      findMany: async () => {
        sessionQuery += 1;
        if (sessionQuery === 1) {
          return [{ id: 21, title: "Conversation", type: "GROUP", startAt: new Date("2026-10-12T10:00:00.000Z") }];
        }
        return [{ id: 22, title: "Grammar", teacherId: 7, completedAt: new Date("2026-10-11T04:00:00.000Z") }];
      },
      count: async () => 1,
    },
    order: {
      findMany: async () => [{
        id: "order-1",
        userId: 20,
        packageId: 4,
        amountCents: 120000,
        currency: "EGP",
        updatedAt: new Date("2026-10-12T05:00:00.000Z"),
        user: { name: "Sara" },
        package: { title: "Fluency" },
      }],
      count: async () => 2,
    },
    user: { count: async () => 3 },
    assessmentSubmission: { count: async () => 4 },
    teacherEarning: {
      aggregate: async () => ({ _sum: { amountMinor: 45000 }, _count: { _all: 5 } }),
    },
    teacherEarningSnapshotJob: {
      findMany: async () => [{ id: 31, sessionId: 22, teacherId: 7, attempts: 3, lastError: "timeout", updatedAt: NOW }],
    },
    userPackage: {
      findMany: async () => {
        packageQuery += 1;
        if (packageQuery === 1) {
          return [{
            id: 41,
            userId: 20,
            title: "Fluency",
            sessionsTotal: 8,
            sessionsUsed: 5,
            expiresAt: new Date("2026-10-15T00:00:00.000Z"),
            user: { name: "Sara" },
          }];
        }
        return [{
          id: 42,
          userId: 21,
          title: "Starter",
          sessionsTotal: 4,
          sessionsUsed: 4,
          expiresAt: null,
          user: { name: "Youssef" },
        }];
      },
      count: async () => 1,
    },
  });

  const counts = await runAdminAlertSweep({
    db,
    now: NOW,
    deliver: async (alert) => alerts.push(alert),
  });

  assert.deepEqual(counts, {
    support: 1,
    sessions: 2,
    payments: 1,
    packages: 2,
    payroll: 1,
    digest: 1,
  });
  assert.equal(alerts.length, 8);
  assert.equal(alerts.some((alert) => alert.type === ADMIN_ALERT_TYPES.SUPPORT_SLA && alert.mandatory), true);
  assert.equal(alerts.some((alert) => alert.type === ADMIN_ALERT_TYPES.SESSION_ATTENTION && alert.data.needsTeacher), true);
  assert.equal(alerts.some((alert) => alert.type === ADMIN_ALERT_TYPES.PAYMENT_ATTENTION), true);
  assert.equal(alerts.filter((alert) => alert.type === ADMIN_ALERT_TYPES.CREDIT_ATTENTION).length, 2);
  assert.equal(alerts.some((alert) => alert.type === ADMIN_ALERT_TYPES.PAYROLL && alert.email === "critical"), true);
  assert.equal(alerts.at(-1).type, ADMIN_ALERT_TYPES.DAILY_DIGEST);
  assert.equal(alerts.at(-1).email, "always");
});

test("one failed sweep check does not suppress the remaining checks", async () => {
  const alerts = [];
  const db = emptyDb({
    supportTicket: {
      findMany: async () => { throw new Error("support table unavailable"); },
      count: async () => 0,
    },
    teacherEarningSnapshotJob: {
      findMany: async () => [{ id: 51, sessionId: 61, teacherId: 7, attempts: 2, lastError: "failed", updatedAt: NOW }],
    },
  });

  const counts = await runAdminAlertSweep({
    db,
    now: NOW,
    deliver: async (alert) => alerts.push(alert),
  });

  assert.equal(counts.support, 0);
  assert.equal(counts.payroll, 1);
  assert.equal(counts.digest, 1);
  assert.equal(alerts.some((alert) => alert.type === ADMIN_ALERT_TYPES.PAYROLL), true);
});

test("admin notification preferences are enabled by default", () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.adminInAppOperationalAlerts, true);
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.adminEmailCriticalAlerts, true);
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.adminDailyDigest, true);
});
