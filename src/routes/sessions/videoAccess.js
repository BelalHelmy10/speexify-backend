// src/routes/sessions/videoAccess.js
//
// GET /api/sessions/:id/video-access
// Hands an authorized classroom member the Jitsi room name and, when token
// auth is configured, a short-lived JWT scoped to that one room. Uses the same
// authorizer as the classroom socket, so lobby admission, locks and
// cancellation apply to video exactly as they do to the classroom itself.

import { Router, prisma, requireAuth, logger } from "./_shared.js";
import { createClassroomJoinAuthorizer } from "../../webrtcSignaling/classroomAuthorization.js";
import {
  buildClassroomRoomName,
  getJitsiDomain,
  isJitsiTokenAuthConfigured,
  signJitsiToken,
} from "../../services/jitsiTokenService.js";

const router = Router();

// Video access is always authorized, even where the socket auth flag is off.
const authorizeVideoJoin = createClassroomJoinAuthorizer({ authEnabled: true });

const DENIAL_STATUS = {
  invalid_classroom_room: 400,
  missing_authenticated_user: 401,
  forbidden_classroom_room: 403,
  classroom_ended: 410,
  classroom_locked: 423,
  classroom_admission_required: 403,
};

export function createVideoAccessHandler({
  authorize = authorizeVideoJoin,
  prismaClient = prisma,
  tokenConfigured = isJitsiTokenAuthConfigured,
  roomNameFor = buildClassroomRoomName,
  signToken = signJitsiToken,
  domain = getJitsiDomain,
} = {}) {
  return async function videoAccessHandler(req, res) {
    res.set("Cache-Control", "no-store");
    try {
      const sessionIdRaw = String(req.params.id || "");
      const userId = Number(req.viewUserId || req.user?.id);
      const authorization = await authorize({ roomId: sessionIdRaw, userId });

      if (!authorization.allowed) {
        return res
          .status(DENIAL_STATUS[authorization.reason] || 403)
          .json({ error: "Video access denied", code: authorization.reason });
      }

      const roomName = roomNameFor(authorization.sessionId);
      const moderator = authorization.role === "teacher" || authorization.role === "admin";

      let jwt = null;
      if (tokenConfigured()) {
        const user = await prismaClient.user.findUnique({
          where: { id: authorization.userId },
          select: { id: true, name: true },
        });
        jwt = signToken({
          room: roomName,
          user: { id: authorization.userId, name: user?.name || (moderator ? "Teacher" : "Learner") },
          moderator,
        });
      }

      return res.json({
        domain: domain(),
        roomName,
        jwt,
        moderator,
      });
    } catch (err) {
      logger.error({ err }, "GET /sessions/:id/video-access failed");
      return res.status(500).json({ error: "Failed to prepare video access" });
    }
  };
}

router.get("/sessions/:id/video-access", requireAuth, createVideoAccessHandler());

export default router;
