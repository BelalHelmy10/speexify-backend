import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateTeacherEarning,
  completeSessionWithTeacherEarningOutbox,
  ensureTeacherEarningForSession,
  getTeacherEarningsReconciliation,
  isTeacherEarningsUnavailable,
  processTeacherEarningSnapshotJob,
  syncTeacherEarnings,
  TEACHER_EARNINGS_CURRENCY,
  TEACHER_EARNING_SNAPSHOT_JOB_STATUS,
  validatePayoutEntries,
} from "../../src/services/teacherEarningsService.js";

test("teacher earnings use EGP piastres and hourly duration", () => {
  const result = calculateTeacherEarning({ rateHourlyEgpPiastres: 12000, minutes: 45 });
  assert.equal(TEACHER_EARNINGS_CURRENCY, "EGP");
  assert.deepEqual(result, { amountMinor: 9000, rateType: "hourly", rateMinor: 12000 });
});

test("per-session rates stay fixed regardless of duration", () => {
  const result = calculateTeacherEarning({ ratePerSessionEgpPiastres: 8500, minutes: 90 });
  assert.deepEqual(result, { amountMinor: 8500, rateType: "per_session", rateMinor: 8500 });
});

test("missing rates create a visible zero-value configuration entry", () => {
  const result = calculateTeacherEarning({ minutes: 60 });
  assert.deepEqual(result, { amountMinor: 0, rateType: "none", rateMinor: null });
});

test("legacy ambiguous rate fields are ignored by the EGP ledger", () => {
  const result = calculateTeacherEarning({ rateHourlyCents: 1000, minutes: 60 });
  assert.deepEqual(result, { amountMinor: 0, rateType: "none", rateMinor: null });
});

test("payout validation returns the exact EGP total for valid pending entries", () => {
  assert.equal(
    validatePayoutEntries([1, 2], [{ id: 1, amountMinor: 9000 }, { id: 2, amountMinor: 8500 }]),
    17500
  );
});

test("payout validation rejects missing, duplicate, and unconfigured entries", () => {
  assert.throws(
    () => validatePayoutEntries([1, 2], [{ id: 1, amountMinor: 9000 }]),
    (error) => error.code === "INVALID_EARNINGS"
  );
  assert.throws(
    () => validatePayoutEntries([1, 1], [{ id: 1, amountMinor: 9000 }]),
    (error) => error.code === "INVALID_EARNINGS"
  );
  assert.throws(
    () => validatePayoutEntries([1], [{ id: 1, amountMinor: 0 }]),
    (error) => error.code === "RATE_NOT_CONFIGURED"
  );
});

test("migration-unavailable errors are distinguishable from ordinary failures", () => {
  assert.equal(isTeacherEarningsUnavailable({ code: "P2021" }), true);
  assert.equal(isTeacherEarningsUnavailable(new Error('The table "TeacherEarning" does not exist')), true);
  assert.equal(isTeacherEarningsUnavailable(new Error("network timeout")), false);
});

test("completion snapshots the effective historical rate and payout keeps that amount after a rate change", async () => {
  const completionAt = new Date("2026-09-20T12:00:00.000Z");
  const historicalRate = {
    id: 41,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    rateHourlyEgpPiastres: 12000,
    ratePerSessionEgpPiastres: null,
  };
  let currentRate = 12000;
  let earning = null;
  const db = {
    session: {
      findUnique: async () => ({
        id: 7,
        teacherId: 3,
        status: "completed",
        startAt: new Date("2026-09-20T11:00:00.000Z"),
        endAt: completionAt,
        completedAt: completionAt,
        updatedAt: completionAt,
        teacher: {
          rateHourlyEgpPiastres: currentRate,
          ratePerSessionEgpPiastres: null,
        },
      }),
      findMany: async () => [{ id: 7 }],
    },
    teacherRateHistory: {
      findFirst: async () => historicalRate,
    },
    teacherEarning: {
      findUnique: async () => earning,
      create: async ({ data }) => {
        earning = { id: 99, ...data };
        return earning;
      },
    },
  };

  const created = await ensureTeacherEarningForSession(7, db);
  assert.equal(created.amountMinor, 12000);
  assert.equal(created.rateMinor, 12000);
  assert.equal(created.rateSnapshotSource, "history");
  assert.equal(created.rateSnapshotAt.toISOString(), completionAt.toISOString());
  assert.equal(created.rateEffectiveFrom.toISOString(), historicalRate.effectiveFrom.toISOString());

  currentRate = 24000;
  await syncTeacherEarnings(3, db);

  assert.equal(earning.amountMinor, 12000);
  assert.equal(
    validatePayoutEntries([earning.id], [earning]),
    12000,
    "payouts must use the immutable completion snapshot"
  );
});

test("normal synchronization does not create missing historical earnings", async () => {
  let createCalled = false;
  let createdData = null;
  const db = {
    session: {
      findMany: async () => [{ id: 8 }],
      findUnique: async () => ({
        id: 8,
        teacherId: 4,
        status: "completed",
        startAt: new Date("2026-09-20T11:00:00.000Z"),
        endAt: new Date("2026-09-20T12:00:00.000Z"),
        completedAt: new Date("2026-09-20T12:00:00.000Z"),
        updatedAt: new Date("2026-09-20T12:00:00.000Z"),
        teacher: { rateHourlyEgpPiastres: 24000, ratePerSessionEgpPiastres: null },
      }),
    },
    teacherRateHistory: {
      findFirst: async () => ({
        id: 52,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        rateHourlyEgpPiastres: 12000,
        ratePerSessionEgpPiastres: null,
      }),
    },
    teacherEarning: {
      findUnique: async () => null,
      create: async ({ data }) => {
        createCalled = true;
        createdData = data;
        return { id: 100, ...data };
      },
    },
  };

  await syncTeacherEarnings(4, db);
  assert.equal(createCalled, false);

  await syncTeacherEarnings(4, db, { allowHistoricalBackfill: true });
  assert.equal(createCalled, true);
  assert.equal(createdData.rateMinor, 12000);
});

test("session completion and payroll outbox insertion are atomic", async () => {
  const calls = [];
  const tx = {
    session: {
      updateMany: async ({ data }) => {
        calls.push({ type: "session.update", data });
        return { count: 1 };
      },
      findUnique: async () => ({ id: 12, teacherId: 8, status: "completed", completedAt: new Date() }),
    },
    teacherEarningSnapshotJob: {
      upsert: async ({ create }) => {
        calls.push({ type: "job.upsert", create });
        return { id: 77, ...create };
      },
    },
  };
  const db = { $transaction: async (callback) => callback(tx) };

  const result = await completeSessionWithTeacherEarningOutbox(12, db);

  assert.equal(result.job.status, TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PENDING);
  assert.equal(result.job.sessionId, 12);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].type, "session.update");
  assert.equal(calls[1].type, "job.upsert");
});

test("failed snapshot delivery is persisted for a durable retry and alert", async () => {
  const updateCalls = [];
  const job = {
    id: 78,
    sessionId: 13,
    teacherId: 8,
    attempts: 0,
  };
  const db = {
    teacherEarningSnapshotJob: {
      updateMany: async (args) => {
        updateCalls.push(args);
        return { count: 1 };
      },
      findUnique: async () => job,
    },
    session: {
      findUnique: async () => ({
        id: 13,
        teacherId: 8,
        status: "completed",
        startAt: new Date("2026-09-20T11:00:00.000Z"),
        endAt: new Date("2026-09-20T12:00:00.000Z"),
        completedAt: new Date("2026-09-20T12:00:00.000Z"),
        updatedAt: new Date("2026-09-20T12:00:00.000Z"),
        teacher: { rateHourlyEgpPiastres: 12000, ratePerSessionEgpPiastres: null },
      }),
    },
    teacherEarning: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("database temporarily unavailable");
      },
    },
    teacherRateHistory: {
      findFirst: async () => null,
    },
  };

  const result = await processTeacherEarningSnapshotJob(78, db, { workerId: "test-worker" });

  assert.equal(result.ok, false);
  assert.equal(result.claimed, true);
  assert.equal(result.attempts, 1);
  assert.equal(updateCalls[0].data.status, TEACHER_EARNING_SNAPSHOT_JOB_STATUS.PROCESSING);
  assert.equal(updateCalls[1].data.status, TEACHER_EARNING_SNAPSHOT_JOB_STATUS.FAILED);
  assert.equal(updateCalls[1].data.attempts, 1);
  assert.match(updateCalls[1].data.lastError, /database temporarily unavailable/);
});

test("payroll reconciliation reports completed sessions, earning rows, and job backlog", async () => {
  const db = {
    session: { count: async () => 10 },
    teacherEarning: { count: async () => 8 },
    teacherEarningSnapshotJob: {
      count: async ({ where }) => {
        if (where.status === "PENDING") return 1;
        if (where.status === "FAILED") return 1;
        return 0;
      },
    },
  };

  const result = await getTeacherEarningsReconciliation(db);

  assert.deepEqual(
    {
      completedSessions: result.completedSessions,
      earningRows: result.earningRows,
      missingEarnings: result.missingEarnings,
      coveragePct: result.coveragePct,
      pendingSnapshotJobs: result.pendingSnapshotJobs,
      failedSnapshotJobs: result.failedSnapshotJobs,
    },
    {
      completedSessions: 10,
      earningRows: 8,
      missingEarnings: 2,
      coveragePct: 80,
      pendingSnapshotJobs: 1,
      failedSnapshotJobs: 1,
    }
  );
});
