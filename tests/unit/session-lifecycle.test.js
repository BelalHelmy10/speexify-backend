import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../src/lib/prisma.js";
import { cancelBooking } from "../../src/services/cancelBooking.js";
import {
  assertSessionCanBeCanceled,
  assertSessionCanBeRescheduled,
  isTerminalSessionStatus,
  rescheduleScheduledSession,
  SESSION_TERMINAL_ERROR_CODE,
} from "../../src/services/sessionLifecycleService.js";

test("completed and canceled sessions are terminal", () => {
  assert.equal(isTerminalSessionStatus("completed"), true);
  assert.equal(isTerminalSessionStatus("canceled"), true);
  assert.equal(isTerminalSessionStatus("scheduled"), false);

  assert.throws(
    () => assertSessionCanBeCanceled({ status: "completed" }),
    (error) => error.code === SESSION_TERMINAL_ERROR_CODE
  );
  assert.throws(
    () => assertSessionCanBeRescheduled({ status: "completed" }),
    (error) => error.code === SESSION_TERMINAL_ERROR_CODE
  );
  assert.throws(
    () => assertSessionCanBeRescheduled({ status: "canceled" }),
    (error) => error.code === SESSION_TERMINAL_ERROR_CODE
  );
  assert.doesNotThrow(() => assertSessionCanBeCanceled({ status: "scheduled" }));
  assert.doesNotThrow(() => assertSessionCanBeRescheduled({ status: "scheduled" }));
});

test("rescheduling is conditionally restricted to scheduled sessions", async () => {
  const calls = [];
  const db = {
    session: {
      updateMany: async (args) => {
        calls.push(args);
        return { count: 1 };
      },
      findUnique: async () => ({ id: 8, status: "scheduled" }),
    },
  };
  const startAt = new Date("2026-09-28T10:00:00.000Z");
  const endAt = new Date("2026-09-28T11:00:00.000Z");

  const result = await rescheduleScheduledSession(8, { startAt, endAt }, db);

  assert.deepEqual(result, { id: 8, status: "scheduled" });
  assert.deepEqual(calls[0], {
    where: { id: 8, status: "scheduled" },
    data: { startAt, endAt },
  });
});

test("rescheduling fails closed when the session is no longer scheduled", async () => {
  const db = {
    session: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ id: 8, status: "completed" }),
    },
  };

  await assert.rejects(
    () =>
      rescheduleScheduledSession(
        8,
        {
          startAt: new Date("2026-09-28T10:00:00.000Z"),
          endAt: new Date("2026-09-28T11:00:00.000Z"),
        },
        db
      ),
    (error) => error.code === SESSION_TERMINAL_ERROR_CODE
  );
});

test("cancelBooking refuses to mutate a completed session", async () => {
  const originalTransaction = prisma.$transaction;
  let sessionUpdateCalled = false;

  prisma.$transaction = async (work) =>
    work({
      $queryRaw: async () => [],
      session: {
        findUnique: async () => ({
          id: 9,
          status: "completed",
          userId: 4,
          participants: [],
        }),
        update: async () => {
          sessionUpdateCalled = true;
          return null;
        },
      },
    });

  try {
    await assert.rejects(
      () => cancelBooking(9),
      (error) => error.code === SESSION_TERMINAL_ERROR_CODE
    );
    assert.equal(sessionUpdateCalled, false);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});
