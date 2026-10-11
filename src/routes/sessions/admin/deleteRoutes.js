// src/routes/sessions/admin/deleteRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  logger,
  audit,
} from "./shared.js";
import { sendCancellationNotifications } from "../../../services/notificationsService.js";

const router = Router();

// DELETE /api/admin/sessions/:id - Delete session
router.delete("/admin/sessions/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const session = await prisma.session.findUnique({ where: { id }, select: { id: true, type: true, title: true, startAt: true, endAt: true, userId: true, teacherId: true, trainingAdminId: true, joinUrl: true, participants: { select: { userId: true, status: true } } } });
    if (!session) return res.status(404).json({ error: "Session not found" });
    await prisma.session.delete({ where: { id } });
    await audit(req.user.id, "session_delete", "Session", id);
    try {
      const learnerIds = session.participants.filter((p) => p.status !== "canceled").map((p) => p.userId);
      if (!learnerIds.length && session.userId) learnerIds.push(session.userId);
      await sendCancellationNotifications({
        session,
        learnerIds,
        teacherId: session.teacherId,
        canceledBy: req.user.id,
        refunded: false,
      });
    } catch (notificationError) {
      logger.error({ err: notificationError, sessionId: id }, "session deletion notifications failed");
    }
    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin.sessions.delete error");
    if (err?.code === "P2003" && String(err?.meta?.field_name || "").includes("TeacherEarning")) {
      return res.status(409).json({
        error: "This session has teacher earnings and cannot be deleted. Cancel it instead to preserve the earnings history.",
      });
    }
    return res.status(500).json({ error: "Failed to delete session" });
  }
});

export default router;
