import test from "node:test";
import assert from "node:assert/strict";

import {
  SENDER_STAMP_KEY,
  filterClassroomEvents,
  stampClassroomEvent,
} from "../../src/webrtcSignaling/classroomEventPolicy.js";

const learner = { userId: 7, role: "learner" };
const teacher = { userId: 3, role: "teacher" };

function fakePrisma(rows) {
  return {
    classroomMessage: {
      findUnique: async ({ where }) => rows[where.id] || null,
    },
  };
}

test("learner cannot emit teacher-only control events", () => {
  for (const type of ["CLASSROOM_LOCK", "SET_RESOURCE", "SCREEN_SHARE_ALLOW", "LOBBY_ADMITTED", "TEACHER_POINTER_MOVE", "PDF_SET_PAGE"]) {
    assert.equal(stampClassroomEvent({ type, locked: true }, learner), null, type);
    assert.ok(stampClassroomEvent({ type }, teacher), type);
  }
  assert.ok(stampClassroomEvent({ type: "CLASSROOM_LOCK" }, { userId: 1, role: "admin" }));
});

test("sender stamp overrides any client-supplied stamp", () => {
  const out = stampClassroomEvent(
    { type: "RAISE_HAND", [SENDER_STAMP_KEY]: { userId: 3, role: "teacher" } },
    learner
  );
  assert.deepEqual(out[SENDER_STAMP_KEY], { userId: 7, role: "learner" });
});

test("typing indicator identity is server-derived", () => {
  const out = stampClassroomEvent({ type: "CHAT_TYPING", role: "teacher", senderId: 3 }, learner);
  assert.equal(out.role, "learner");
  assert.equal(out.senderId, 7);
});

test("malformed events are dropped", () => {
  assert.equal(stampClassroomEvent(null, teacher), null);
  assert.equal(stampClassroomEvent([], teacher), null);
  assert.equal(stampClassroomEvent({ type: 5 }, teacher), null);
});

test("forged chat message is rebuilt from the database row or dropped", async () => {
  const createdAt = new Date("2026-11-21T10:00:00Z");
  const prismaClient = fakePrisma({
    m1: { id: "m1", sessionId: 9, senderId: 7, senderRole: "learner", senderName: "Lea", body: "real", visibility: "public", deletedAt: null, createdAt },
    m2: { id: "m2", sessionId: 9, senderId: 3, senderRole: "teacher", senderName: "T", body: "teacher said", visibility: "public", deletedAt: null, createdAt },
    m3: { id: "m3", sessionId: 10, senderId: 7, senderRole: "learner", body: "other room", visibility: "public", deletedAt: null, createdAt },
  });
  const events = [
    { type: "CHAT_MESSAGE", message: { id: "m1", role: "teacher", name: "Teacher", text: "fake" } },
    { type: "CHAT_MESSAGE", message: { id: "m2" } }, // someone else's message
    { type: "CHAT_MESSAGE", message: { id: "m3" } }, // other session
    { type: "CHAT_MESSAGE", message: { id: "nope", text: "invented" } },
  ];
  const out = await filterClassroomEvents(events, { sessionId: 9, sender: learner, prismaClient });
  assert.equal(out.length, 1);
  assert.equal(out[0].message.text, "real");
  assert.equal(out[0].message.role, "learner");
  assert.equal(out[0].role, "learner");
  assert.equal(out[0].name, "Lea");
});

test("chat delete only relays a persisted deletion", async () => {
  const createdAt = new Date("2026-11-21T10:00:00Z");
  const prismaClient = fakePrisma({
    live: { id: "live", sessionId: 9, senderId: 3, senderRole: "teacher", body: "keep", visibility: "public", deletedAt: null, createdAt },
    gone: { id: "gone", sessionId: 9, senderId: 7, senderRole: "learner", body: "x", visibility: "public", deletedAt: createdAt, createdAt },
  });
  const out = await filterClassroomEvents(
    [{ type: "CHAT_DELETE", messageId: "live" }, { type: "CHAT_DELETE", messageId: "gone" }],
    { sessionId: 9, sender: learner, prismaClient }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].messageId, "gone");
  assert.equal(out[0].message.isDeleted, true);
  assert.equal(out[0].message.text, "");
});

test("ordinary learner events pass through stamped", async () => {
  const out = await filterClassroomEvents(
    [{ type: "RAISE_HAND", raised: true }, { type: "ANNOTATION_STATE", resourceId: "r" }],
    { sessionId: 9, sender: learner, prismaClient: fakePrisma({}) }
  );
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e[SENDER_STAMP_KEY].userId === 7));
});
