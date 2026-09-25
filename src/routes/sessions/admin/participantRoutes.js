import { cancelBooking } from "../../../services/cancelBooking.js";
import { bookingTransaction, lockSession } from "../../../services/bookingTransaction.js";
import { consumeOneCreditWithClient } from "../../../services/sessionsService.js";
// src/routes/sessions/admin/participantRoutes.js

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  findSessionConflictsWithClient,
  lockSchedulingResources,
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

      const creditResults = await bookingTransaction(async (tx) => {
        await lockSession(tx, sessionId);
        const current = await tx.session.findUnique({
          where: { id: sessionId }, include: { participants: true },
        });
        if (!current || current.status !== "scheduled") {
          throw Object.assign(new Error("Session is no longer available"), { statusCode: 409 });
        }
        const activeIds = new Set(current.participants.filter(p => p.status !== "canceled").map(p => p.userId));
        const additions = [...new Set(toAdd)].filter(uid => !activeIds.has(uid));
        await lockSchedulingResources(tx, {
          learnerIds: additions,
          teacherId: current.teacherId,
        });
        if (!allowOverCapacity && current.capacity && activeIds.size + additions.length > current.capacity) {
          throw Object.assign(new Error("Session capacity exceeded"), { statusCode: 409 });
        }
        const results = [];
        for (const uid of additions) {
          const conflicts = await findSessionConflictsWithClient(tx, {
            startAt: current.startAt,
            endAt: current.endAt,
            userId: uid,
            teacherId: current.teacherId || undefined,
            excludeId: sessionId,
          });
          if (conflicts.length) {
            throw Object.assign(new Error("Learner has a time conflict"), {
              statusCode: 409,
              responseBody: { error: "Time conflict", userId: uid, conflicts },
            });
          }
          if (!allowNoCredit) {
            const debit = await consumeOneCreditWithClient(tx, uid, sessionId);
            if (!debit.ok) throw Object.assign(new Error("Learner has no credits"), { statusCode: 422 });
            results.push({ learnerId: uid, consumed: true, packId: debit.packId });
          }
          await tx.sessionParticipant.upsert({
            where: { sessionId_userId: { sessionId, userId: uid } },
            create: { sessionId, userId: uid, status: "booked" },
            update: { status: "booked" },
          });
        }
        return results;
      });

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
      if (e?.statusCode && e?.responseBody) {
        return res.status(e.statusCode).json(e.responseBody);
      }
      if (e?.statusCode) {
        return res.status(e.statusCode).json({ error: e.message });
      }
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
      if (session.status === "completed") {
        return res.status(409).json({
          code: "SESSION_TERMINAL",
          error: "Completed sessions cannot be canceled",
        });
      }

      const refundable = !!refund && new Date(session.startAt).getTime() - Date.now() >= 12 * 60 * 60 * 1000;
      const cancellation = await cancelBooking(sessionId, {userId: targetUserId, refund: refundable});
      const refunded = cancellation.refundResults.some(r => r.refunded);

      await audit(req.user.id, "session_remove_participant", "Session", sessionId, {
        removedUserId: targetUserId,
        refunded,
      });

      return res.json({ ok: true, removed: true, refunded });
    } catch (e) {
      logger.error({ err: e }, "admin.sessions.removeParticipant error");
      if (e?.code === "SESSION_TERMINAL") {
        return res.status(409).json({ code: e.code, error: e.message });
      }
      return res.status(500).json({ error: "Failed to remove participant" });
    }
  }
);

export default router;
