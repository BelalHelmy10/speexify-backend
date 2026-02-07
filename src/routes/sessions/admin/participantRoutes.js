// src/routes/sessions/admin/participantRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCredit,
  refundOneCredit,
  sendBookingNotifications,
  logger,
  audit,
} from "./shared.js";
import {
  getIdempotencyKeyFromRequest,
  beginIdempotentRequest,
  completeIdempotentRequest,
  abandonIdempotentRequest,
} from "../../../services/idempotencyService.js";

const router = Router();

// POST /api/admin/sessions/:id/participants - Add participants to GROUP session
router.post(
  "/admin/sessions/:id/participants",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    let idempotency = null;

    try {
      const sessionId = Number(req.params.id);
      if (!sessionId || Number.isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session id" });
      }

      const {
        userId,
        userIds,
        allowNoCredit = false,
        allowOverCapacity = false,
      } = req.body || {};

      const idsRaw = Array.isArray(userIds) ? userIds : userId ? [userId] : [];
      const ids = idsRaw
        .map((x) => Number(x))
        .filter((x) => x && !Number.isNaN(x));

      if (!ids.length) {
        return res.status(400).json({ error: "Provide userId or userIds[]" });
      }

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          type: true,
          status: true,
          capacity: true,
          startAt: true,
          endAt: true,
          teacherId: true,
          participants: { select: { userId: true, status: true } },
        },
      });

      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.type !== "GROUP") {
        return res.status(400).json({
          error: "Only GROUP sessions support participants management",
        });
      }
      if (session.status === "canceled") {
        return res
          .status(400)
          .json({ error: "Cannot add participants to a canceled session" });
      }
      if (session.status === "completed") {
        return res
          .status(400)
          .json({ error: "Cannot add participants to a completed session" });
      }

      const existing = new Map(
        (session.participants || []).map((p) => [p.userId, p.status])
      );

      const toAdd = ids.filter((uid) => {
        const st = existing.get(uid);
        return !st || st === "canceled";
      });

      if (!toAdd.length) {
        return res.json({ ok: true, added: 0, alreadyInSession: ids });
      }

      const activeCount = (session.participants || []).filter(
        (p) => p.status !== "canceled"
      ).length;
      const nextCount = activeCount + toAdd.length;

      if (!allowOverCapacity && session.capacity && nextCount > session.capacity) {
        return res.status(400).json({
          error: "capacity_exceeded",
          message: "Adding these learners exceeds session capacity",
          capacity: session.capacity,
          activeCount,
          attemptingToAdd: toAdd.length,
        });
      }

      const startAt = new Date(session.startAt);
      const endAt = session.endAt ? new Date(session.endAt) : null;

      for (const uid of toAdd) {
        const u = await prisma.user.findUnique({
          where: { id: uid },
          select: { id: true, role: true, isDisabled: true },
        });
        if (!u || u.isDisabled) {
          return res
            .status(404)
            .json({ error: "User not found or disabled", userId: uid });
        }
        if (u.role !== "learner" && u.role !== "admin") {
          return res
            .status(400)
            .json({ error: "userId must refer to a learner", userId: uid });
        }

        const conflicts = await findSessionConflicts({
          startAt,
          endAt,
          userId: uid,
          teacherId: session.teacherId || undefined,
        });
        if (conflicts.length) {
          return res
            .status(409)
            .json({ error: "Time conflict", userId: uid, conflicts });
        }

        const remaining = await getRemainingCredits(uid);
        if (!allowNoCredit && remaining <= 0) {
          return res.status(422).json({
            error: "no_credits",
            userId: uid,
            message: "Learner has no remaining credits",
          });
        }
      }

      idempotency = await beginIdempotentRequest({
        actorId: req.user.id,
        scope: `admin.sessions.addParticipants.${sessionId}`,
        key: getIdempotencyKeyFromRequest(req),
        payload: {
          sessionId,
          toAdd,
          allowNoCredit: !!allowNoCredit,
          allowOverCapacity: !!allowOverCapacity,
        },
      });

      if (idempotency.state === "replay") {
        return res.status(idempotency.statusCode).json(idempotency.responseBody);
      }
      if (
        idempotency.state === "conflict" ||
        idempotency.state === "in_progress" ||
        idempotency.state === "error"
      ) {
        return res.status(idempotency.statusCode).json(idempotency.responseBody);
      }

      await prisma.$transaction(async (tx) => {
        for (const uid of toAdd) {
          const existedStatus = existing.get(uid);
          if (existedStatus === "canceled") {
            await tx.sessionParticipant.updateMany({
              where: { sessionId, userId: uid },
              data: { status: "booked" },
            });
          } else {
            await tx.sessionParticipant.create({
              data: { sessionId, userId: uid, status: "booked" },
            });
          }
        }
      });

      const creditResults = [];
      if (!allowNoCredit) {
        for (const uid of toAdd) {
          try {
            const result = await consumeOneCredit(uid);
            creditResults.push({ learnerId: uid, consumed: result.ok });
            if (!result.ok) {
              logger.warn(
                { userId: uid, sessionId },
                "[credits] Failed to consume credit when adding participant"
              );
            }
          } catch (e) {
            logger.error(
              { err: e, userId: uid, sessionId },
              "[credits] consumeOneCredit failed when adding participant"
            );
            creditResults.push({ learnerId: uid, consumed: false });
          }
        }
      }

      await audit(req.user.id, "session_add_participants", "Session", sessionId, {
        addedUserIds: toAdd,
        creditResults,
      });

      try {
        await sendBookingNotifications({
          session,
          learnerIds: toAdd,
          teacherId: session.teacherId,
          bookedBy: req.user.id,
        });
      } catch (e) {
        logger.error(
          { err: e, sessionId: session.id },
          "booking notifications failed for added participants"
        );
      }

      const responseBody = { ok: true, added: toAdd.length, userIds: toAdd };
      if (idempotency?.state === "started") {
        await completeIdempotentRequest(idempotency.recordId, {
          statusCode: 201,
          responseBody,
          resourceId: sessionId,
        });
      }

      return res.status(201).json(responseBody);
    } catch (e) {
      if (idempotency?.state === "started") {
        await abandonIdempotentRequest(idempotency.recordId);
      }
      logger.error({ err: e }, "admin.sessions.addParticipants error");
      return res.status(500).json({ error: "Failed to add participants" });
    }
  }
);

// DELETE /api/admin/sessions/:id/participants/:userId - Remove participant
router.delete(
  "/admin/sessions/:id/participants/:userId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const sessionId = Number(req.params.id);
      const targetUserId = Number(req.params.userId);
      const refund = String(req.query.refund || "") === "1";

      if (!sessionId || Number.isNaN(sessionId)) {
        return res.status(400).json({ error: "Invalid session id" });
      }
      if (!targetUserId || Number.isNaN(targetUserId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }

      const session = await prisma.session.findUnique({
        where: { id: sessionId },
        select: {
          id: true,
          type: true,
          status: true,
          startAt: true,
          participants: { select: { userId: true, status: true } },
        },
      });

      if (!session) return res.status(404).json({ error: "Session not found" });
      if (session.type !== "GROUP") {
        return res.status(400).json({
          error: "Only GROUP sessions support participants management",
        });
      }

      const row = (session.participants || []).find((p) => p.userId === targetUserId);
      if (!row) {
        return res.status(404).json({ error: "Participant not found in session" });
      }

      if (row.status === "canceled") {
        return res.json({
          ok: true,
          removed: true,
          alreadyCanceled: true,
          refunded: false,
        });
      }

      await prisma.sessionParticipant.updateMany({
        where: { sessionId, userId: targetUserId },
        data: { status: "canceled" },
      });

      let refunded = false;

      if (refund && session.status !== "completed") {
        const startsAt = new Date(session.startAt);
        const twelveHoursMs = 12 * 60 * 60 * 1000;
        const refundable = startsAt.getTime() - Date.now() >= twelveHoursMs;

        if (refundable) {
          try {
            const r = await refundOneCredit(targetUserId);
            refunded = !!r.ok;
            if (!r.ok) {
              logger.warn(
                { userId: targetUserId, sessionId },
                "[credits] admin remove seat refund not applied (none to refund)"
              );
            }
          } catch (e) {
            logger.error(
              { err: e, userId: targetUserId, sessionId },
              "[credits] admin remove seat refund failed"
            );
          }
        }
      }

      await audit(req.user.id, "session_remove_participant", "Session", sessionId, {
        removedUserId: targetUserId,
        refunded,
      });

      return res.json({ ok: true, removed: true, refunded });
    } catch (e) {
      logger.error({ err: e }, "admin.sessions.removeParticipant error");
      return res.status(500).json({ error: "Failed to remove participant" });
    }
  }
);

export default router;
