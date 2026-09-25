import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/lifecycle.js";
import { prisma } from "../../src/lib/prisma.js";

const sessionFixture = {
  id: 42,
  type: "ONE_ON_ONE",
  status: "completed",
  userId: 10,
  teacherId: 20,
  participants: [],
};

async function completeAs(actor, session = sessionFixture) {
  const originalUserFindUnique = prisma.user.findUnique;
  const originalSessionFindUnique = prisma.session.findUnique;

  prisma.user.findUnique = async () => ({
    ...actor,
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => session;

  const app = express();
  app.use((req, _res, next) => {
    req.session = { user: { id: actor.id } };
    next();
  });
  app.use(router);

  try {
    return await request(app).post(`/sessions/${session.id}/complete`);
  } finally {
    prisma.user.findUnique = originalUserFindUnique;
    prisma.session.findUnique = originalSessionFindUnique;
  }
}

test("session owner cannot complete a session or trigger payroll", async () => {
  let transactionCalled = false;
  const originalTransaction = prisma.$transaction;
  prisma.$transaction = async () => {
    transactionCalled = true;
    throw new Error("completion transaction should not run");
  };

  try {
    const response = await completeAs(
      { id: sessionFixture.userId, role: "learner" },
      { ...sessionFixture, status: "scheduled" }
    );

    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { error: "Forbidden" });
    assert.equal(transactionCalled, false);
  } finally {
    prisma.$transaction = originalTransaction;
  }
});

test("assigned teacher can complete a session", async () => {
  const response = await completeAs({ id: sessionFixture.teacherId, role: "teacher" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, alreadyCompleted: true });
});

test("admin can complete a session", async () => {
  const response = await completeAs({ id: 99, role: "admin" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, alreadyCompleted: true });
});

test("unassigned teachers cannot complete a session", async () => {
  const response = await completeAs({ id: 21, role: "teacher" });

  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: "Forbidden" });
});
