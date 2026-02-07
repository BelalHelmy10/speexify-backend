// src/routes/sessions/admin/deleteRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  logger,
  audit,
} from "./shared.js";

const router = Router();

// DELETE /api/admin/sessions/:id - Delete session
router.delete("/admin/sessions/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.session.delete({ where: { id } });
    await audit(req.user.id, "session_delete", "Session", id);
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin.sessions.delete error");
    return res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;
