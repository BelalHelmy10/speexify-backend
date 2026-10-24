import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/classroom.js";
import { prisma } from "../../src/lib/prisma.js";

test("classroom connection telemetry accepts members and rejects outsiders", async () => {
  const originals = {
    user: prisma.user.findUnique,
    session: prisma.session.findUnique,
  };

  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    role: where.id === 20 ? "teacher" : "learner",
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => ({
    id: 42,
    teacherId: 20,
    userId: 10,
    participants: [{ userId: 10, status: "booked" }],
    classroomState: {},
  });

  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"] || 10) } };
    next();
  });
  app.use(router);

  try {
    const payload = {
      event: "conference_joined",
      details: { elapsedMs: 1250, retryAttempt: 0 },
      userAgent: "Test Browser",
      viewport: { width: 390, height: 844, devicePixelRatio: 3 },
      online: true,
      visibility: "visible",
      occurredAt: new Date().toISOString(),
    };

    const learner = await request(app)
      .post("/sessions/42/classroom-event")
      .set("x-test-user", "10")
      .send(payload);
    assert.equal(learner.statusCode, 200);
    assert.equal(learner.body.ok, true);

    const teacher = await request(app)
      .post("/sessions/42/classroom-event")
      .set("x-test-user", "20")
      .send({ ...payload, event: "connection_failed", details: { reason: "peer_connection_failure" } });
    assert.equal(teacher.statusCode, 200);

    const outsider = await request(app)
      .post("/sessions/42/classroom-event")
      .set("x-test-user", "30")
      .send(payload);
    assert.equal(outsider.statusCode, 403);

    const invalidSession = await request(app)
      .post("/sessions/not-a-session/classroom-event")
      .set("x-test-user", "10")
      .send(payload);
    assert.equal(invalidSession.statusCode, 400);
  } finally {
    prisma.user.findUnique = originals.user;
    prisma.session.findUnique = originals.session;
  }
});
