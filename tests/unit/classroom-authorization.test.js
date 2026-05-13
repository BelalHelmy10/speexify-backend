import test from "node:test";
import assert from "node:assert/strict";
import { createClassroomJoinAuthorizer } from "../../src/webrtcSignaling/classroomAuthorization.js";

function createFakePrisma({ user = null, session = null } = {}) {
  return {
    $transaction: async (queries) => Promise.all(queries),
    user: {
      findUnique: async () => user,
    },
    session: {
      findUnique: async () => session,
    },
  };
}

function createSession(overrides = {}) {
  return {
    id: 42,
    userId: 10,
    teacherId: 20,
    participants: [],
    ...overrides,
  };
}

test("classroom join authorizer allows teachers, legacy learners, participants, and admins", async () => {
  const cases = [
    {
      name: "teacher",
      user: { id: 20, role: "teacher", isDisabled: false },
      session: createSession(),
      userId: 20,
    },
    {
      name: "legacy learner",
      user: { id: 10, role: "learner", isDisabled: false },
      session: createSession(),
      userId: 10,
    },
    {
      name: "group participant",
      user: { id: 30, role: "learner", isDisabled: false },
      session: createSession({
        participants: [{ userId: 30, status: "booked" }],
      }),
      userId: 30,
    },
    {
      name: "admin",
      user: { id: 99, role: "admin", isDisabled: false },
      session: createSession(),
      userId: 99,
    },
  ];

  for (const entry of cases) {
    const authorize = createClassroomJoinAuthorizer({
      prismaClient: createFakePrisma(entry),
      authEnabled: true,
    });

    const result = await authorize({
      roomId: "42",
      userId: String(entry.userId),
    });

    assert.equal(result.allowed, true, entry.name);
  }
});

test("classroom join authorizer rejects unrelated users and canceled seats", async () => {
  const unrelatedAuthorize = createClassroomJoinAuthorizer({
    prismaClient: createFakePrisma({
      user: { id: 40, role: "learner", isDisabled: false },
      session: createSession({
        participants: [{ userId: 30, status: "booked" }],
      }),
    }),
    authEnabled: true,
  });

  const canceledAuthorize = createClassroomJoinAuthorizer({
    prismaClient: createFakePrisma({
      user: { id: 30, role: "learner", isDisabled: false },
      session: createSession({
        participants: [{ userId: 30, status: "canceled" }],
      }),
    }),
    authEnabled: true,
  });

  assert.equal(
    (await unrelatedAuthorize({ roomId: "42", userId: "40" })).allowed,
    false
  );
  assert.equal(
    (await canceledAuthorize({ roomId: "42", userId: "30" })).allowed,
    false
  );
});

test("classroom join authorizer rejects invalid room ids, missing users, and disabled users", async () => {
  const authorize = createClassroomJoinAuthorizer({
    prismaClient: createFakePrisma({
      user: { id: 10, role: "learner", isDisabled: false },
      session: createSession(),
    }),
    authEnabled: true,
  });

  assert.equal((await authorize({ roomId: "abc", userId: "10" })).allowed, false);
  assert.equal((await authorize({ roomId: "42", userId: "" })).allowed, false);

  const disabledAuthorize = createClassroomJoinAuthorizer({
    prismaClient: createFakePrisma({
      user: { id: 10, role: "learner", isDisabled: true },
      session: createSession(),
    }),
    authEnabled: true,
  });

  assert.equal(
    (await disabledAuthorize({ roomId: "42", userId: "10" })).allowed,
    false
  );
});

