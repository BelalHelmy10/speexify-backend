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

function isAllowedClassroomMember({ user, session, userId }) {
  if (!user || user.isDisabled) return false;
  if (!session) return false;

  const role = String(user.role || "").toLowerCase();
  const isAdmin = role === "admin";
  const isTeacher = session.teacherId === userId;
  const isLegacyLearner = session.userId === userId;
  const isParticipant = hasActiveParticipantSeat(session, userId);

  return isAdmin || isTeacher || isLegacyLearner || isParticipant;
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
          participants: {
            select: {
              userId: true,
              status: true,
            },
          },
        },
      }),
    ]);

    if (!isAllowedClassroomMember({ user, session, userId: numericUserId })) {
      return { allowed: false, reason: "forbidden_classroom_room" };
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

