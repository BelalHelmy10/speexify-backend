import test from "node:test";
import assert from "node:assert/strict";
import {
  CLASSROOM_LOBBY_STATUS,
  requestLobbyAdmission,
  updateClassroomStateAtomic,
} from "../../src/services/classroomStateService.js";

function yieldToCompetingWriter() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createConcurrentStatePrisma() {
  const stored = {
    classroomState: {},
    classroomStateVersion: 0,
  };

  return {
    stored,
    session: {
      async findUnique() {
        const snapshot = structuredClone(stored);
        await yieldToCompetingWriter();
        return snapshot;
      },
      async updateMany({ where, data }) {
        await yieldToCompetingWriter();
        if (where.classroomStateVersion !== stored.classroomStateVersion) {
          return { count: 0 };
        }
        stored.classroomState = structuredClone(data.classroomState);
        stored.classroomStateVersion += data.classroomStateVersion.increment;
        return { count: 1 };
      },
    },
  };
}

function createConcurrentLobbyPrisma() {
  const entries = new Map();
  const keyFor = (sessionId, userId) => `${sessionId}:${userId}`;

  return {
    entries,
    classroomLobbyEntry: {
      async findUnique({ where }) {
        const { sessionId, userId } = where.sessionId_userId;
        const entry = entries.get(keyFor(sessionId, userId));
        await yieldToCompetingWriter();
        return entry ? structuredClone(entry) : null;
      },
      async create({ data }) {
        await yieldToCompetingWriter();
        const key = keyFor(data.sessionId, data.userId);
        if (entries.has(key)) {
          const error = new Error("Unique constraint");
          error.code = "P2002";
          throw error;
        }
        const entry = { ...data, decidedAt: null };
        entries.set(key, entry);
        return structuredClone(entry);
      },
      async updateMany({ where, data }) {
        await yieldToCompetingWriter();
        const key = keyFor(where.sessionId, where.userId);
        const entry = entries.get(key);
        if (!entry || entry.status !== where.status) return { count: 0 };
        entries.set(key, { ...entry, ...data });
        return { count: 1 };
      },
    },
  };
}

test("concurrent classroom patches merge instead of losing a writer", async () => {
  const prismaClient = createConcurrentStatePrisma();

  await Promise.all([
    updateClassroomStateAtomic({
      prismaClient,
      sessionId: 42,
      buildNextState: (state) => ({ ...state, resourceId: "lesson-2" }),
    }),
    updateClassroomStateAtomic({
      prismaClient,
      sessionId: 42,
      buildNextState: (state) => ({
        ...state,
        moderation: { ...(state.moderation || {}), lobbyEnabled: false },
      }),
    }),
  ]);

  assert.deepEqual(prismaClient.stored.classroomState, {
    resourceId: "lesson-2",
    moderation: { lobbyEnabled: false },
  });
  assert.equal(prismaClient.stored.classroomStateVersion, 2);
});

test("simultaneous learner joins create independent durable lobby rows", async () => {
  const prismaClient = createConcurrentLobbyPrisma();
  const learners = Array.from({ length: 40 }, (_, index) => index + 100);

  await Promise.all(learners.map((userId) => requestLobbyAdmission(prismaClient, {
    sessionId: 42,
    userId,
    displayName: `Learner ${userId}`,
    email: `learner-${userId}@example.test`,
  })));

  assert.equal(prismaClient.entries.size, learners.length);
  assert.ok([...prismaClient.entries.values()].every(
    (entry) => entry.status === CLASSROOM_LOBBY_STATUS.WAITING
  ));
});

test("duplicate join retries are idempotent and never duplicate a lobby row", async () => {
  const prismaClient = createConcurrentLobbyPrisma();

  const results = await Promise.all(Array.from({ length: 20 }, () => requestLobbyAdmission(
    prismaClient,
    {
      sessionId: 42,
      userId: 100,
      displayName: "May Salim",
      email: "may@example.test",
    }
  )));

  assert.equal(prismaClient.entries.size, 1);
  assert.ok(results.every((entry) => entry.status === CLASSROOM_LOBBY_STATUS.WAITING));
});
