// A locked classroom stops late joins but lets learners who were already in
// come back, and the chat is only for learners who were let in.
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/classroom.js";
import { prisma } from "../../src/lib/prisma.js";

function setup({ moderation = {}, entries = {} } = {}) {
  const lobby = new Map(Object.entries(entries).map(([userId, status]) => [Number(userId), { sessionId: 42, userId: Number(userId), status }]));
  const originals = {
    userFindUnique: prisma.user.findUnique,
    sessionFindUnique: prisma.session.findUnique,
    lobbyFindUnique: prisma.classroomLobbyEntry.findUnique,
    lobbyCreate: prisma.classroomLobbyEntry.create,
    messagesFindMany: prisma.classroomMessage.findMany,
  };
  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    name: `User ${where.id}`,
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
    classroomState: { moderation },
    classroomStateVersion: 1,
    participants: [10, 11, 12].map((userId) => ({ userId, status: "booked" })),
  });
  prisma.classroomLobbyEntry.findUnique = async ({ where }) => lobby.get(where.sessionId_userId.userId) || null;
  prisma.classroomLobbyEntry.create = async ({ data }) => {
    lobby.set(data.userId, data);
    return data;
  };
  prisma.classroomMessage.findMany = async () => [
    { id: "m1", sessionId: 42, senderId: 20, senderRole: "teacher", senderName: "Teacher", body: "Welcome", visibility: "public", createdAt: new Date("2026-11-27T10:00:00Z") },
  ];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"]) } };
    next();
  });
  app.use(router);
  const restore = () => {
    prisma.user.findUnique = originals.userFindUnique;
    prisma.session.findUnique = originals.sessionFindUnique;
    prisma.classroomLobbyEntry.findUnique = originals.lobbyFindUnique;
    prisma.classroomLobbyEntry.create = originals.lobbyCreate;
    prisma.classroomMessage.findMany = originals.messagesFindMany;
  };
  return { app, lobby, restore };
}

const join = (app, userId) => request(app).post("/sessions/42/lobby/join").set("x-test-user", String(userId)).send({});

test("a locked room lets admitted learners back in and keeps late joiners out", async () => {
  for (const lobbyEnabled of [true, false]) {
    const t = setup({ moderation: { lobbyEnabled, locked: true }, entries: { 10: "ADMITTED" } });
    try {
      const back = await join(t.app, 10);
      assert.equal(back.statusCode, 200, `lobby ${lobbyEnabled}`);
      assert.equal(back.body.status, "admitted");

      const late = await join(t.app, 11);
      assert.equal(late.statusCode, 403, `lobby ${lobbyEnabled}`);
      assert.equal(late.body.status, "denied");

      const teacher = await join(t.app, 20);
      assert.equal(teacher.body.status, "admitted");
    } finally {
      t.restore();
    }
  }
});

test("with the lobby off, joining records the learner as admitted", async () => {
  const t = setup({ moderation: { lobbyEnabled: false } });
  try {
    const res = await join(t.app, 12);
    assert.equal(res.body.status, "admitted");
    assert.equal(t.lobby.get(12)?.status, "ADMITTED");
  } finally {
    t.restore();
  }
});

test("chat is closed to learners still waiting or removed", async () => {
  const t = setup({ moderation: { lobbyEnabled: true }, entries: { 10: "ADMITTED", 11: "WAITING", 12: "DENIED" } });
  try {
    const chat = (userId) => request(t.app).get("/sessions/42/chat/messages").set("x-test-user", String(userId));
    assert.equal((await chat(10)).statusCode, 200);
    assert.equal((await chat(20)).statusCode, 200);
    const waiting = await chat(11);
    assert.equal(waiting.statusCode, 403);
    assert.equal(waiting.body.code, "classroom_admission_required");
    assert.equal((await chat(12)).statusCode, 403);

    const post = await request(t.app)
      .post("/sessions/42/chat/messages")
      .set("x-test-user", "11")
      .send({ text: "Let me in" });
    assert.equal(post.statusCode, 403);
  } finally {
    t.restore();
  }
});

test("reloading a locked classroom works for admitted learners only", async () => {
  const { default: crudRouter } = await import("../../src/routes/sessions/crud.js");
  const t = setup({ moderation: { lobbyEnabled: true, locked: true }, entries: { 10: "ADMITTED" } });
  const sessionFindUnique = prisma.session.findUnique;
  prisma.session.findUnique = async (args) => ({
    ...(await sessionFindUnique(args)),
    title: "Group lesson",
    startAt: new Date(Date.now() - 10 * 60 * 1000),
    endAt: new Date(Date.now() + 50 * 60 * 1000),
    participants: [10, 11].map((userId) => ({ userId, status: "booked", user: { id: userId, name: `User ${userId}`, email: null, role: "learner" } })),
    feedback: null,
    teacher: { id: 20, name: "Teacher", email: null },
    user: null,
  });
  const app = express();
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"]) } };
    next();
  });
  app.use(crudRouter);
  try {
    const open = (userId) => request(app).get("/sessions/42?classroomJoin=1").set("x-test-user", String(userId));
    assert.equal((await open(10)).statusCode, 200);
    const late = await open(11);
    assert.equal(late.statusCode, 423);
    assert.equal(late.body.code, "CLASSROOM_LOCKED");
  } finally {
    t.restore();
  }
});
