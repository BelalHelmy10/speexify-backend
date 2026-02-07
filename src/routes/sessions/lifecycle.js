// src/routes/sessions/lifecycle.js
// Session lifecycle: complete, cancel, reschedule

import {
    Router,
    prisma,
    requireAuth,
    findSessionConflicts,
    refundOneCredit,
    sendCancellationNotifications,
    logger,
} from "./_shared.js";
import {
    getIdempotencyKeyFromRequest,
    beginIdempotentRequest,
    completeIdempotentRequest,
    abandonIdempotentRequest,
} from "../../services/idempotencyService.js";

const router = Router();

// --------------------------------------------------------------------------
// POST /api/sessions/:id/complete - Mark session as completed
// FIX: Unified credit consumption - consume for ALL non-canceled participants
// --------------------------------------------------------------------------
router.post("/sessions/:id/complete", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const session = await prisma.session.findUnique({
            where: { id },
            select: {
                id: true,
                type: true,
                status: true,
                userId: true,
                teacherId: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!session) return res.status(404).json({ error: "Not found" });

        const canComplete =
            req.user.role === "admin" ||
            req.user.id === session.teacherId ||
            req.user.id === session.userId;

        if (!canComplete) return res.status(403).json({ error: "Forbidden" });

        // Already completed - do nothing
        if (session.status === "completed") {
            return res.json({ ok: true, alreadyCompleted: true });
        }

        // Update status to completed
        await prisma.session.update({
            where: { id },
            data: { status: "completed" },
        });

        // Credits are consumed on booking, not on completion
        // No credit operations needed here

        res.json({ ok: true });
    } catch (e) {
        logger.error({ err: e }, "complete error");
        res.status(500).json({ error: "Failed to complete session" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/cancel - Cancel session or participant seat
// --------------------------------------------------------------------------
router.post("/sessions/:id/cancel", requireAuth, async (req, res) => {
    let idempotency = null;

    try {
        const id = Number(req.params.id);

        const sessionRow = await prisma.session.findUnique({
            where: { id },
            select: {
                id: true,
                title: true,
                type: true,
                status: true,
                startAt: true,
                endAt: true,
                userId: true,
                teacherId: true,
                joinUrl: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!sessionRow) {
            return res.status(404).json({ error: "Session not found" });
        }

        const viewerId = req.viewUserId;
        const isAdmin = req.user.role === "admin";
        const isTeacher =
            !!sessionRow.teacherId && sessionRow.teacherId === req.user.id;

        const participant = (sessionRow.participants || []).find(
            (p) => p.userId === viewerId
        );
        const isLegacyOwner = sessionRow.userId === viewerId;
        const isLearner = !!participant || isLegacyOwner;

        if (!(isAdmin || isTeacher || isLearner)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        // No-op for already-canceled sessions to prevent duplicate refunds.
        if (sessionRow.status === "canceled") {
            return res.json({
                ok: true,
                scope: "session",
                alreadyCanceled: true,
                refunded: false,
                refundResults: [],
            });
        }

        idempotency = await beginIdempotentRequest({
            actorId: req.user.id,
            scope: `sessions.cancel.${sessionRow.id}`,
            key: getIdempotencyKeyFromRequest(req),
            payload: {
                sessionId: sessionRow.id,
                actorId: req.user.id,
                viewerId,
                role: req.user.role,
                body: req.body || {},
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

        const startsAt = new Date(sessionRow.startAt);
        const twelveHoursMs = 12 * 60 * 60 * 1000;
        const refundableByLearner =
            startsAt.getTime() - Date.now() >= twelveHoursMs;

        // ─────────────────────────────────────────────
        // GROUP: learner cancels ONLY their seat
        // ─────────────────────────────────────────────
        if (sessionRow.type === "GROUP" && isLearner && !isAdmin && !isTeacher) {
            // Mark this learner's participant row as canceled
            await prisma.sessionParticipant.updateMany({
                where: {
                    sessionId: sessionRow.id,
                    userId: viewerId,
                },
                data: { status: "canceled" },
            });

            // Refund only this learner if policy allows
            let refunded = false;
            if (refundableByLearner && sessionRow.status !== "completed") {
                try {
                    const r = await refundOneCredit(viewerId);
                    refunded = r.ok;
                } catch (e) {
                    logger.error(
                        { err: e, userId: viewerId, sessionId: sessionRow.id },
                        "[credits] group seat cancel refund failed"
                    );
                }
            }

            // ✅ Send cancellation notifications (in-app + email)
            try {
                await sendCancellationNotifications({
                    session: sessionRow,
                    learnerIds: [viewerId],
                    teacherId: sessionRow.teacherId,
                    canceledBy: req.user.id,
                    scope: "participant",
                    refunded,
                });
            } catch (e) {
                logger.error(
                    { err: e, sessionId: sessionRow.id },
                    "cancellation notifications failed"
                );
            }

            const responseBody = {
                ok: true,
                scope: "participant",
                refunded,
            };
            if (idempotency?.state === "started") {
                await completeIdempotentRequest(idempotency.recordId, {
                    statusCode: 200,
                    responseBody,
                    resourceId: sessionRow.id,
                });
            }

            return res.json(responseBody);
        }

        // ─────────────────────────────────────────────
        // Otherwise: cancel the whole session
        // ─────────────────────────────────────────────
        const updated = await prisma.session.update({
            where: { id: sessionRow.id },
            data: { status: "canceled" },
            select: {
                id: true,
                status: true,
                type: true,
            },
        });

        const refundableWholeSession =
            startsAt.getTime() - Date.now() >= twelveHoursMs &&
            sessionRow.status !== "completed";

        const refundResults = [];

        // Handle refunds
        if (refundableWholeSession) {
            if (sessionRow.type === "GROUP") {
                const seats = (sessionRow.participants || [])
                    .filter((p) => p.status !== "canceled")
                    .map((p) => p.userId);

                for (const learnerId of seats) {
                    try {
                        const r = await refundOneCredit(learnerId);
                        refundResults.push({ learnerId, refunded: r.ok });
                    } catch (e) {
                        logger.error(
                            { err: e, userId: learnerId, sessionId: sessionRow.id },
                            "[credits] group cancel refund failed"
                        );
                        refundResults.push({ learnerId, refunded: false });
                    }
                }
            } else {
                const learnerId =
                    sessionRow.userId ||
                    (sessionRow.participants?.length
                        ? sessionRow.participants[0].userId
                        : null);

                if (learnerId) {
                    try {
                        const r = await refundOneCredit(learnerId);
                        refundResults.push({ learnerId, refunded: r.ok });
                    } catch (e) {
                        logger.error(
                            { err: e, userId: learnerId, sessionId: sessionRow.id },
                            "[credits] cancel refund failed"
                        );
                        refundResults.push({ learnerId, refunded: false });
                    }
                }
            }
        }

        // ✅ Determine recipients
        const learnerIds = [];
        if (sessionRow.type === "GROUP") {
            const active = (sessionRow.participants || [])
                .filter((p) => p.status !== "canceled")
                .map((p) => p.userId);
            learnerIds.push(...active);
        } else {
            const learnerId =
                sessionRow.userId ||
                (sessionRow.participants?.length
                    ? sessionRow.participants[0].userId
                    : null);
            if (learnerId) learnerIds.push(learnerId);
        }

        // ✅ Send cancellation notifications (in-app + email)
        try {
            await sendCancellationNotifications({
                session: sessionRow,
                learnerIds,
                teacherId: sessionRow.teacherId,
                canceledBy: req.user.id,
                scope: "session",
                refunded: refundableWholeSession,
            });
        } catch (e) {
            logger.error(
                { err: e, sessionId: sessionRow.id },
                "cancellation notifications failed"
            );
        }

        const responseBody = {
            ok: true,
            scope: "session",
            refunded: refundableWholeSession,
            refundResults,
            session: updated,
        };
        if (idempotency?.state === "started") {
            await completeIdempotentRequest(idempotency.recordId, {
                statusCode: 200,
                responseBody,
                resourceId: sessionRow.id,
            });
        }

        return res.json(responseBody);
    } catch (e) {
        if (idempotency?.state === "started") {
            await abandonIdempotentRequest(idempotency.recordId);
        }
        logger.error({ err: e }, "Cancel failed");
        res.status(400).json({ error: "Failed to cancel session" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/reschedule - Reschedule a session
// FIX: Check conflicts for ALL participants in GROUP sessions
// --------------------------------------------------------------------------
router.post("/sessions/:id/reschedule", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { startAt, endAt } = req.body;

        if (!startAt) return res.status(400).json({ error: "startAt is required" });

        const session = await prisma.session.findUnique({
            where: { id },
            select: {
                id: true,
                type: true,
                userId: true,
                teacherId: true,
                status: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!session) return res.status(404).json({ error: "Not found" });

        const isOwner = session.userId === req.user.id;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";
        if (!(isOwner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        const newStart = new Date(startAt);
        const newEnd = endAt ? new Date(endAt) : null;

        // FIX: Check conflicts for ALL active participants in GROUP sessions
        if (session.type === "GROUP") {
            const activeParticipants = (session.participants || [])
                .filter((p) => p.status !== "canceled")
                .map((p) => p.userId);

            for (const participantId of activeParticipants) {
                const conflicts = await findSessionConflicts({
                    startAt: newStart,
                    endAt: newEnd,
                    userId: participantId,
                    teacherId: session.teacherId,
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
            // ONE_ON_ONE: check legacy userId
            const conflicts = await findSessionConflicts({
                startAt: newStart,
                endAt: newEnd,
                userId: session.userId,
                teacherId: session.teacherId,
                excludeId: id,
            });

            if (conflicts.length) {
                return res.status(409).json({ error: "Time conflict", conflicts });
            }
        }

        const updated = await prisma.session.update({
            where: { id },
            data: {
                startAt: newStart,
                endAt: newEnd,
                status: "scheduled",
            },
        });

        res.json({ ok: true, session: updated });
    } catch (e) {
        logger.error({ err: e }, "reschedule error");
        res.status(400).json({ error: "Failed to reschedule session" });
    }
});

export default router;
