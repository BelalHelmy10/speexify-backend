const MAX_STATE_WRITE_ATTEMPTS = 12;
const MAX_LOBBY_WRITE_ATTEMPTS = 6;

export const CLASSROOM_LOBBY_STATUS = Object.freeze({
  WAITING: "WAITING",
  ADMITTED: "ADMITTED",
  DENIED: "DENIED",
});

/**
 * Whether a learner (not teacher/admin) must stay out of the live classroom.
 * With the lobby on, only ADMITTED learners are in. With it off, everyone is
 * in except learners the teacher removed (DENIED) and removed learners who
 * asked to come back and are WAITING for the teacher again.
 */
export function isLearnerLobbyBlocked({ lobbyEnabled, status }) {
  if (lobbyEnabled) return status !== CLASSROOM_LOBBY_STATUS.ADMITTED;
  return status === CLASSROOM_LOBBY_STATUS.DENIED || status === CLASSROOM_LOBBY_STATUS.WAITING;
}

function isUniqueConstraintError(error) {
  return error?.code === "P2002";
}

function waitForContention(attempt) {
  const delayMs = Math.min(25, 2 ** attempt) + Math.floor(Math.random() * 4);
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export class ClassroomStateContentionError extends Error {
  constructor(sessionId) {
    super(`Classroom state for session ${sessionId} is temporarily busy`);
    this.name = "ClassroomStateContentionError";
    this.code = "CLASSROOM_STATE_CONTENTION";
  }
}

/**
 * Applies a partial classroom-state mutation with optimistic concurrency.
 *
 * Each attempt reads the newest document version, builds a new document, and
 * updates only if the version has not changed. Concurrent updates to different
 * fields are therefore merged instead of silently replacing one another.
 */
export async function updateClassroomStateAtomic({
  prismaClient,
  sessionId,
  buildNextState,
  maxAttempts = MAX_STATE_WRITE_ATTEMPTS,
}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const current = await prismaClient.session.findUnique({
      where: { id: sessionId },
      select: {
        classroomState: true,
        classroomStateVersion: true,
      },
    });

    if (!current) return null;

    const version = Number(current.classroomStateVersion) || 0;
    const nextState = buildNextState(current.classroomState);
    const result = await prismaClient.session.updateMany({
      where: {
        id: sessionId,
        classroomStateVersion: version,
      },
      data: {
        classroomState: nextState,
        classroomStateVersion: { increment: 1 },
      },
    });

    if (result.count === 1) {
      return {
        state: nextState,
        version: version + 1,
      };
    }

    await waitForContention(attempt);
  }

  throw new ClassroomStateContentionError(sessionId);
}

export function toWaitingLearner(entry) {
  return {
    id: entry.userId,
    name: entry.displayName || "Learner",
    email: entry.email || null,
    joinedAt: entry.joinedAt instanceof Date
      ? entry.joinedAt.toISOString()
      : new Date(entry.joinedAt).toISOString(),
  };
}

export async function findLobbyEntry(prismaClient, sessionId, userId) {
  return prismaClient.classroomLobbyEntry.findUnique({
    where: {
      sessionId_userId: { sessionId, userId },
    },
  });
}

export async function listWaitingLobbyEntries(prismaClient, sessionId) {
  return prismaClient.classroomLobbyEntry.findMany({
    where: {
      sessionId,
      status: CLASSROOM_LOBBY_STATUS.WAITING,
    },
    orderBy: [{ joinedAt: "asc" }, { userId: "asc" }],
  });
}

export async function getWaitingLobbyPosition(prismaClient, entry) {
  if (!entry || entry.status !== CLASSROOM_LOBBY_STATUS.WAITING) return null;

  return prismaClient.classroomLobbyEntry.count({
    where: {
      sessionId: entry.sessionId,
      status: CLASSROOM_LOBBY_STATUS.WAITING,
      OR: [
        { joinedAt: { lt: entry.joinedAt } },
        {
          joinedAt: entry.joinedAt,
          userId: { lte: entry.userId },
        },
      ],
    },
  });
}

/**
 * Idempotently requests admission. An admitted learner can never be demoted by
 * a retry, while a denied learner may explicitly rejoin the back of the queue.
 */
export async function requestLobbyAdmission(prismaClient, {
  sessionId,
  userId,
  displayName,
  email,
  now = new Date(),
}) {
  for (let attempt = 0; attempt < MAX_LOBBY_WRITE_ATTEMPTS; attempt += 1) {
    const existing = await findLobbyEntry(prismaClient, sessionId, userId);

    if (existing?.status === CLASSROOM_LOBBY_STATUS.ADMITTED) {
      return existing;
    }

    if (existing) {
      const isRejoin = existing.status === CLASSROOM_LOBBY_STATUS.DENIED;
      const result = await prismaClient.classroomLobbyEntry.updateMany({
        where: {
          sessionId,
          userId,
          status: existing.status,
        },
        data: {
          status: CLASSROOM_LOBBY_STATUS.WAITING,
          displayName,
          email,
          decidedAt: null,
          ...(isRejoin ? { joinedAt: now } : {}),
        },
      });

      if (result.count === 1) {
        return findLobbyEntry(prismaClient, sessionId, userId);
      }
    } else {
      try {
        return await prismaClient.classroomLobbyEntry.create({
          data: {
            sessionId,
            userId,
            status: CLASSROOM_LOBBY_STATUS.WAITING,
            displayName,
            email,
            joinedAt: now,
          },
        });
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }

    await waitForContention(attempt);
  }

  throw new ClassroomStateContentionError(sessionId);
}

// With the lobby off, learners walk straight in. Recording that they were
// admitted lets them reconnect after the teacher locks the room, while a
// locked room still keeps out anyone who never joined. An existing entry
// (for example a learner the teacher removed) is left as it is.
export async function recordDirectAdmission(prismaClient, { sessionId, userId, now = new Date() }) {
  try {
    await prismaClient.classroomLobbyEntry.create({
      data: {
        sessionId,
        userId,
        status: CLASSROOM_LOBBY_STATUS.ADMITTED,
        joinedAt: now,
        decidedAt: now,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }
}

export async function decideLobbyEntry(prismaClient, {
  sessionId,
  userId,
  status,
  displayName = null,
  email = null,
  now = new Date(),
}) {
  if (![CLASSROOM_LOBBY_STATUS.ADMITTED, CLASSROOM_LOBBY_STATUS.DENIED].includes(status)) {
    throw new TypeError(`Unsupported lobby decision: ${status}`);
  }

  return prismaClient.classroomLobbyEntry.upsert({
    where: {
      sessionId_userId: { sessionId, userId },
    },
    create: {
      sessionId,
      userId,
      status,
      displayName,
      email,
      joinedAt: now,
      decidedAt: now,
    },
    update: {
      status,
      decidedAt: now,
    },
  });
}

export async function admitAllWaitingLobbyEntries(prismaClient, sessionId, now = new Date()) {
  return prismaClient.classroomLobbyEntry.updateManyAndReturn({
    where: {
      sessionId,
      status: CLASSROOM_LOBBY_STATUS.WAITING,
    },
    data: {
      status: CLASSROOM_LOBBY_STATUS.ADMITTED,
      decidedAt: now,
    },
    select: {
      userId: true,
    },
  });
}
