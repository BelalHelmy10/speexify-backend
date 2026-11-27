// src/routes/sessions/screenShare.js
//
// GET /api/sessions/:id/screen-share/ice
// ICE servers for the classroom's browser-to-browser screen sharing, for
// classroom members the classroom socket would also admit.

import { Router, requireAuth, logger } from "./_shared.js";
import { createClassroomJoinAuthorizer } from "../../webrtcSignaling/classroomAuthorization.js";
import { buildIceServers } from "../../services/iceServers.js";

const router = Router();
const authorizeJoin = createClassroomJoinAuthorizer({ authEnabled: true });

export function createIceServersHandler({ authorize = authorizeJoin, build = buildIceServers } = {}) {
  return async function iceServersHandler(req, res) {
    res.set("Cache-Control", "no-store");
    try {
      const userId = Number(req.viewUserId || req.user?.id);
      const authorization = await authorize({ roomId: String(req.params.id || ""), userId });
      if (!authorization.allowed) {
        return res.status(403).json({ error: "Screen sharing is not available", code: authorization.reason });
      }
      return res.json({ iceServers: build(authorization.userId) });
    } catch (err) {
      logger.error({ err }, "GET /sessions/:id/screen-share/ice failed");
      return res.status(500).json({ error: "Failed to prepare screen sharing" });
    }
  };
}

router.get("/sessions/:id/screen-share/ice", requireAuth, createIceServersHandler());

export default router;
