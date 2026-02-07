// src/routes/sessions/admin/bulkRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  refundOneCredit,
  logger,
  audit,
} from "./shared.js";

const router = Router();

// POST /api/admin/sessions/bulk - Bulk session operations
router.post("/admin/sessions/bulk", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { ids, action, teacherId } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }
    if (!["delete", "cancel", "assign-teacher"].includes(action)) {
      return res.status(400).json({
        error: "Invalid action. Use: delete, cancel, or assign-teacher",
      });
    }
    if (action === "assign-teacher" && !teacherId) {
      return res.status(400).json({
        error: "teacherId is required for assign-teacher action",
      });
    }

    const sessionIds = ids.map((id) => Number(id)).filter((id) => !isNaN(id));
    if (sessionIds.length === 0) {
      return res.status(400).json({ error: "No valid session IDs provided" });
    }

    const sessions = await prisma.session.findMany({
      where: { id: { in: sessionIds } },
      select: {
        id: true,
        status: true,
        type: true,
        userId: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (sessions.length === 0) {
      return res.status(404).json({ error: "No sessions found with provided IDs" });
    }

    let affected = 0;
    let refundedCredits = 0;
    const errors = [];

    for (const session of sessions) {
      try {
        if (action === "delete") {
          await prisma.session.delete({ where: { id: session.id } });
          await audit(req.user.id, "session_delete", "Session", session.id, { bulk: true });
          affected++;
        } else if (action === "cancel") {
          if (session.status !== "canceled") {
            await prisma.session.update({
              where: { id: session.id },
              data: { status: "canceled" },
            });

            if (session.type === "GROUP") {
              const seats = (session.participants || [])
                .filter((p) => p.status !== "canceled")
                .map((p) => p.userId);

              for (const learnerId of seats) {
                try {
                  const resRef = await refundOneCredit(learnerId);
                  if (resRef.ok) refundedCredits++;
                } catch (e) {
                  logger.error({ err: e, learnerId, sessionId: session.id }, "Bulk cancel refund failed");
                }
              }
            } else {
              const learnerId =
                session.userId ||
                (session.participants?.length ? session.participants[0].userId : null);
              if (learnerId) {
                try {
                  const resRef = await refundOneCredit(learnerId);
                  if (resRef.ok) refundedCredits++;
                } catch (e) {
                  logger.error({ err: e, learnerId, sessionId: session.id }, "Bulk cancel refund failed");
                }
              }
            }

            await audit(req.user.id, "session_cancel", "Session", session.id, { bulk: true });
            affected++;
          }
        } else if (action === "assign-teacher") {
          const teacher = await prisma.user.findFirst({
            where: { id: Number(teacherId), role: { in: ["teacher", "admin"] } },
          });

          if (!teacher) {
            errors.push({ sessionId: session.id, error: "Invalid teacher ID" });
            continue;
          }

          await prisma.session.update({
            where: { id: session.id },
            data: { teacherId: Number(teacherId) },
          });

          await audit(req.user.id, "session_assign_teacher", "Session", session.id, {
            teacherId: Number(teacherId),
            bulk: true,
          });
          affected++;
        }
      } catch (e) {
        logger.error({ err: e, sessionId: session.id }, `Bulk ${action} failed for session`);
        errors.push({ sessionId: session.id, error: e.message });
      }
    }

    return res.json({
      ok: true,
      affected,
      total: sessions.length,
      action,
      ...(action === "cancel" ? { refundedCredits } : {}),
      ...(action === "assign-teacher" ? { teacherId: Number(teacherId) } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    });
  } catch (err) {
    logger.error({ err }, "admin.sessions.bulk error");
    return res.status(500).json({ error: "Failed to perform bulk operation" });
  }
});

export default router;
