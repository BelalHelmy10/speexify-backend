import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/lifecycle.js";
import adminUpdateRouter from "../../src/routes/sessions/admin/updateRoutes.js";
import { prisma } from "../../src/lib/prisma.js";

const baseSession = {
  id: 43,
  type: "ONE_ON_ONE",
  status: "completed",
  userId: 10,
  teacherId: 20,
  participants: [],
};

async function callAsTeacher(method, path, session, body) {
  const originalUserFindUnique = prisma.user.findUnique;
  const originalSessionFindUnique = prisma.session.findUnique;
  const originalSessionFindMany = prisma.session.findMany;
  const originalSessionUpdateMany = prisma.session.updateMany;
  let currentSession = { ...session };

  prisma.user.findUnique = async () => ({
    id: 20,
    role: "teacher",
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => currentSession;
  prisma.session.findMany = async () => [];
  prisma.session.updateMany = async ({ data }) => {
    currentSession = { ...currentSession, ...data };
    return { count: 1 };
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { id: 20 } };
    next();
  });
  app.use(router);

  try {
    return await request(app)[method](path).send(body);
  } finally {
    prisma.user.findUnique = originalUserFindUnique;
    prisma.session.findUnique = originalSessionFindUnique;
    prisma.session.findMany = originalSessionFindMany;
    prisma.session.updateMany = originalSessionUpdateMany;
  }
}

test("completed sessions cannot be canceled through the lifecycle route", async () => {
  const response = await callAsTeacher(
    "post",
    `/sessions/${baseSession.id}/cancel`,
    baseSession
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "SESSION_TERMINAL");
  assert.match(response.body.error, /cannot be canceled/i);
});

test("completed sessions cannot be rescheduled through the lifecycle route", async () => {
  const response = await callAsTeacher(
    "post",
    `/sessions/${baseSession.id}/reschedule`,
    baseSession,
    {
      startAt: "2026-09-28T10:00:00.000Z",
      endAt: "2026-09-28T11:00:00.000Z",
    }
  );

  assert.equal(response.statusCode, 409);
  assert.equal(response.body.code, "SESSION_TERMINAL");
  assert.match(response.body.error, /rescheduled/i);
});

test("scheduled sessions remain reschedulable without changing lifecycle state", async () => {
  const response = await callAsTeacher(
    "post",
    `/sessions/${baseSession.id}/reschedule`,
    { ...baseSession, status: "scheduled" },
    {
      startAt: "2026-09-28T10:00:00.000Z",
      endAt: "2026-09-28T11:00:00.000Z",
    }
  );

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.session.status, "scheduled");
  assert.equal(response.body.session.startAt, "2026-09-28T10:00:00.000Z");
});

test("admin edits cannot reschedule a completed session", async () => {
  const originalUserFindUnique = prisma.user.findUnique;
  const originalSessionFindUnique = prisma.session.findUnique;
  const originalSessionFindMany = prisma.session.findMany;
  const originalSessionUpdate = prisma.session.update;
  let updateCalled = false;

  prisma.user.findUnique = async () => ({
    id: 99,
    role: "admin",
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => baseSession;
  prisma.session.findMany = async () => [];
  prisma.session.update = async () => {
    updateCalled = true;
    return baseSession;
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { id: 99 } };
    next();
  });
  app.use(adminUpdateRouter);

  try {
    const response = await request(app)
      .patch(`/admin/sessions/${baseSession.id}`)
      .send({
        startAt: "2026-09-28T10:00:00.000Z",
        endAt: "2026-09-28T11:00:00.000Z",
      });

    assert.equal(response.statusCode, 409);
    assert.equal(response.body.code, "SESSION_TERMINAL");
    assert.equal(updateCalled, false);
  } finally {
    prisma.user.findUnique = originalUserFindUnique;
    prisma.session.findUnique = originalSessionFindUnique;
    prisma.session.findMany = originalSessionFindMany;
    prisma.session.update = originalSessionUpdate;
  }
});
