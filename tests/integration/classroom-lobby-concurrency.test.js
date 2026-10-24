import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/classroom.js";
import { prisma } from "../../src/lib/prisma.js";

test("simultaneous HTTP lobby joins remain independently visible to the teacher", async () => {
  const originals = {
    userFindUnique: prisma.user.findUnique,
    sessionFindUnique: prisma.session.findUnique,
    lobbyFindUnique: prisma.classroomLobbyEntry.findUnique,
    lobbyFindMany: prisma.classroomLobbyEntry.findMany,
    lobbyCreate: prisma.classroomLobbyEntry.create,
    lobbyUpdateMany: prisma.classroomLobbyEntry.updateMany,
    lobbyCount: prisma.classroomLobbyEntry.count,
  };
  const entries = new Map();
  const keyFor = (sessionId, userId) => `${sessionId}:${userId}`;

  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    name: where.id === 10 ? "May Salim" : where.id === 11 ? "Second Learner" : "Teacher",
    email: `user-${where.id}@example.test`,
    role: where.id === 20 ? "teacher" : "learner",
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => ({
    id: 42,
    type: "GROUP",
    userId: null,
    teacherId: 20,
    status: "scheduled",
    endAt: null,
    classroomState: { moderation: { lobbyEnabled: true } },
    participants: [
      { userId: 10, status: "booked" },
      { userId: 11, status: "booked" },
    ],
  });
  prisma.classroomLobbyEntry.findUnique = async ({ where }) => {
    const { sessionId, userId } = where.sessionId_userId;
    return entries.get(keyFor(sessionId, userId)) || null;
  };
  prisma.classroomLobbyEntry.create = async ({ data }) => {
    await new Promise((resolve) => setImmediate(resolve));
    const key = keyFor(data.sessionId, data.userId);
    if (entries.has(key)) {
      const error = new Error("Unique constraint");
      error.code = "P2002";
      throw error;
    }
    const entry = { ...data, decidedAt: null };
    entries.set(key, entry);
    return entry;
  };
  prisma.classroomLobbyEntry.updateMany = async ({ where, data }) => {
    const key = keyFor(where.sessionId, where.userId);
    const entry = entries.get(key);
    if (!entry || entry.status !== where.status) return { count: 0 };
    entries.set(key, { ...entry, ...data });
    return { count: 1 };
  };
  prisma.classroomLobbyEntry.findMany = async ({ where }) => [...entries.values()]
    .filter((entry) => entry.sessionId === where.sessionId && entry.status === where.status)
    .sort((left, right) => left.joinedAt - right.joinedAt || left.userId - right.userId);
  prisma.classroomLobbyEntry.count = async ({ where }) => [...entries.values()]
    .filter((entry) => entry.sessionId === where.sessionId && entry.status === where.status)
    .filter((entry) => entry.joinedAt < where.OR[1].joinedAt || (
      entry.joinedAt.getTime() === where.OR[1].joinedAt.getTime()
      && entry.userId <= where.OR[1].userId.lte
    )).length;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"] || 10) } };
    next();
  });
  app.use(router);

  try {
    const [first, second] = await Promise.all([
      request(app).post("/sessions/42/lobby/join").set("x-test-user", "10").send({}),
      request(app).post("/sessions/42/lobby/join").set("x-test-user", "11").send({}),
    ]);

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    assert.equal(first.body.status, "waiting");
    assert.equal(second.body.status, "waiting");

    const teacherView = await request(app)
      .get("/sessions/42/lobby")
      .set("x-test-user", "20");

    assert.equal(teacherView.statusCode, 200);
    assert.equal(teacherView.body.waiting.length, 2);
    assert.deepEqual(
      new Set(teacherView.body.waiting.map((entry) => entry.id)),
      new Set([10, 11])
    );
  } finally {
    prisma.user.findUnique = originals.userFindUnique;
    prisma.session.findUnique = originals.sessionFindUnique;
    prisma.classroomLobbyEntry.findUnique = originals.lobbyFindUnique;
    prisma.classroomLobbyEntry.findMany = originals.lobbyFindMany;
    prisma.classroomLobbyEntry.create = originals.lobbyCreate;
    prisma.classroomLobbyEntry.updateMany = originals.lobbyUpdateMany;
    prisma.classroomLobbyEntry.count = originals.lobbyCount;
  }
});
