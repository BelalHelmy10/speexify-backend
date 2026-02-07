// src/routes/sessions/admin/updateRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  refundOneCredit,
  logger,
  audit,
} from "./shared.js";

const router = Router();

// PATCH /api/admin/sessions/:id - Update session
router.patch("/admin/sessions/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.session.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        status: true,
        startAt: true,
        endAt: true,
        userId: true,
        teacherId: true,
        participants: { select: { userId: true, status: true } },
      },
    });

    if (!existing) return res.status(404).json({ error: "Not found" });

    const patch = {};
    const allowed = [
      "title",
      "joinUrl",
      "status",
      "startAt",
      "endAt",
      "userId",
      "teacherId",
      "capacity",
      "notes",
    ];
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = req.body[k];
    }

    if (patch.joinUrl === undefined && req.body.meetingUrl !== undefined) {
      patch.joinUrl = req.body.meetingUrl;
    }

    if (patch.joinUrl !== undefined) {
      patch.joinUrl = String(patch.joinUrl || "").trim() || null;
    }
    if (patch.notes !== undefined) {
      patch.notes = String(patch.notes || "").trim() || null;
    }

    const start = patch.startAt ? new Date(patch.startAt) : existing.startAt;
    const end = patch.endAt ? new Date(patch.endAt) : existing.endAt;
    const teacherId =
      patch.teacherId !== undefined ? Number(patch.teacherId) : existing.teacherId;

    if (patch.startAt || patch.endAt || patch.teacherId) {
      if (existing.type === "GROUP") {
        const activeParticipants = (existing.participants || [])
          .filter((p) => p.status !== "canceled")
          .map((p) => p.userId);

        for (const participantId of activeParticipants) {
          const conflicts = await findSessionConflicts({
            startAt: start,
            endAt: end,
            userId: participantId,
            teacherId,
            excludeId: id,
          });
          if (conflicts.length) {
            return res.status(409).json({
              error: "Time conflict",
              conflictingUserId: participantId,
              conflicts,
            });
          }
        }
      } else {
        const userId = patch.userId !== undefined ? Number(patch.userId) : existing.userId;

        const conflicts = await findSessionConflicts({
          startAt: start,
          endAt: end,
          userId,
          teacherId,
          excludeId: id,
        });
        if (conflicts.length) {
          return res.status(409).json({ error: "Time conflict", conflicts });
        }
      }
    }

    if (patch.userId !== undefined) patch.userId = Number(patch.userId) || null;
    if (patch.teacherId !== undefined) patch.teacherId = Number(patch.teacherId) || null;
    if (patch.capacity !== undefined) patch.capacity = Number(patch.capacity) || null;
    if (patch.startAt !== undefined) patch.startAt = new Date(patch.startAt);
    if (patch.endAt !== undefined) patch.endAt = patch.endAt ? new Date(patch.endAt) : null;

    const prevStatus = existing.status;
    const nextStatus = patch.status ?? existing.status;

    let shouldRefund = false;

    if (prevStatus !== "canceled" && nextStatus === "canceled") {
      shouldRefund = true;
    }

    const updated = await prisma.session.update({
      where: { id },
      data: patch,
      include: {
        user: { select: { id: true, name: true, email: true } },
        teacher: { select: { id: true, name: true, email: true } },
        participants: {
          select: {
            userId: true,
            status: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    const creditResults = [];

    if (shouldRefund) {
      if (existing.type === "GROUP") {
        const seats = (existing.participants || [])
          .filter((p) => p.status !== "canceled")
          .map((p) => p.userId);

        for (const learnerId of seats) {
          try {
            const resRef = await refundOneCredit(learnerId);
            creditResults.push({
              learnerId,
              action: "refund",
              ok: resRef.ok,
            });
          } catch (e) {
            logger.error(
              { err: e, userId: learnerId, sessionId: updated.id },
              "[credits] refund failed on admin cancel"
            );
            creditResults.push({
              learnerId,
              action: "refund",
              ok: false,
            });
          }
        }
      } else {
        const learnerId =
          existing.userId ||
          (existing.participants?.length ? existing.participants[0].userId : null);

        if (learnerId) {
          try {
            const resRef = await refundOneCredit(learnerId);
            creditResults.push({
              learnerId,
              action: "refund",
              ok: resRef.ok,
            });
          } catch (e) {
            logger.error(
              { err: e, userId: learnerId, sessionId: updated.id },
              "[credits] refund failed on admin cancel"
            );
            creditResults.push({
              learnerId,
              action: "refund",
              ok: false,
            });
          }
        }
      }
    }

    await audit(req.user.id, "session_update", "Session", id, {
      ...patch,
      creditResults,
    });

    const activeParticipants = (updated.participants || []).filter(
      (p) => p.status !== "canceled"
    );

    return res.json({
      ...updated,
      participantCount: activeParticipants.length,
      learners:
        updated.type === "GROUP"
          ? activeParticipants.map((p) => ({ ...p.user, status: p.status }))
          : updated.user
            ? [{ ...updated.user, status: "booked" }]
            : [],
      creditResults,
    });
  } catch (err) {
    logger.error({ err }, "admin.sessions.patch error");
    return res.status(500).json({ error: "Failed to update session" });
  }
});

export default router;
