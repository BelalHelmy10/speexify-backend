// src/webrtcSignaling/classroomAuthorization.js

import { prisma } from "../lib/prisma.js";
import { CONFIG } from "./config.js";

function parseClassroomSessionId(roomId) {
  const normalized = String(roomId || "").trim();
  if (!/^\d+$/.test(normalized)) return null;

  const sessionId = Number(normalized);
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) return null;

  return sessionId;
}

function parseUserId(userId) {
  const numericUserId = Number(userId);
  if (!Number.isSafeInteger(numericUserId) || numericUserId <= 0) return null;
  return numericUserId;
}

function hasActiveParticipantSeat(session, userId) {
  return (session?.participants || []).some(
    (participant) =>
      participant.userId === userId && participant.status !== "canceled"
  );
}

function getClassroomMembership({ user, session, userId }) {
  if (!user || user.isDisabled || !session) {
    return {
      isAllowed: false,
      isAdmin: false,
      isTeacher: false,
      isLearner: false,
    };
  }

  const role = String(user.role || "").toLowerCase();
  const isAdmin = role === "admin";
  const isTeacher = session.teacherId === userId;
  const isLegacyLearner = session.userId === userId;
  const isParticipant = hasActiveParticipantSeat(session, userId);
  const isLearner = isLegacyLearner || isParticipant;

  return {
    isAllowed: isAdmin || isTeacher || isLearner,
    isAdmin,
    isTeacher,
    isLearner,
  };
}

function isClassroomLocked(session) {
  const state = session?.classroomState;
  return Boolean(
    state &&
      typeof state === "object" &&
      !Array.isArray(state) &&
      state.moderation?.locked
  );
}

export function createClassroomJoinAuthorizer({
  prismaClient = prisma,
  authEnabled = CONFIG.AUTH_ENABLED,
} = {}) {
  return async function authorizeClassroomJoin({ roomId, userId }) {
    if (!authEnabled) {
      return { allowed: true, reason: "auth_disabled" };
    }

    const sessionId = parseClassroomSessionId(roomId);
    if (!sessionId) {
      return { allowed: false, reason: "invalid_classroom_room" };
    }

    const numericUserId = parseUserId(userId);
    if (!numericUserId) {
      return { allowed: false, reason: "missing_authenticated_user" };
    }

    const [user, session] = await prismaClient.$transaction([
      prismaClient.user.findUnique({
        where: { id: numericUserId },
        select: {
          id: true,
          role: true,
          isDisabled: true,
        },
      }),
      prismaClient.session.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          userId: true,
          teacherId: true,
          classroomState: true,
          participants: {
            select: {
              userId: true,
              status: true,
            },
          },
        },
      }),
    ]);

    const membership = getClassroomMembership({ user, session, userId: numericUserId });
    if (!membership.isAllowed) {
      return { allowed: false, reason: "forbidden_classroom_room" };
    }

    if (
      isClassroomLocked(session) &&
      membership.isLearner &&
      !membership.isTeacher &&
      !membership.isAdmin
    ) {
      return { allowed: false, reason: "classroom_locked" };
    }

    return {
      allowed: true,
      reason: "authorized",
      sessionId,
      userId: numericUserId,
    };
  };
}

export const authorizeClassroomJoin = createClassroomJoinAuthorizer();
