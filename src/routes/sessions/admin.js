// src/routes/sessions/admin.js
// Admin session management endpoints

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
} from "./_shared.js";
import {
    getIdempotencyKeyFromRequest,
    beginIdempotentRequest,
    completeIdempotentRequest,
    abandonIdempotentRequest,
} from "../../services/idempotencyService.js";

const router = Router();
const ADMIN_SESSIONS_DEFAULT_LIMIT = 100;
const ADMIN_SESSIONS_MAX_LIMIT = 250;
const ADMIN_SESSIONS_MAX_OFFSET = 10000;

function parseBoundedInt(value, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// --------------------------------------------------------------------------
// GET /api/admin/sessions - List all sessions (admin)
// --------------------------------------------------------------------------
router.get("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
    try {
        const {
            q = "",
            userId = "",
            teacherId = "",
            type = "",
            range = "",
        } = req.query;
        const take = parseBoundedInt(req.query.limit, {
            fallback: ADMIN_SESSIONS_DEFAULT_LIMIT,
            min: 1,
            max: ADMIN_SESSIONS_MAX_LIMIT,
        });
        const skip = parseBoundedInt(req.query.offset, {
            fallback: 0,
            min: 0,
            max: ADMIN_SESSIONS_MAX_OFFSET,
        });

        const now = new Date();
        const where = {};

        // Filter by legacy userId OR participant
        if (userId && Number.isFinite(Number(userId))) {
            const uid = Number(userId);
            where.OR = [{ userId: uid }, { participants: { some: { userId: uid } } }];
        }

        if (teacherId && Number.isFinite(Number(teacherId))) {
            where.teacherId = Number(teacherId);
        }

        if (type === "ONE_ON_ONE" || type === "GROUP") {
            where.type = type;
        }

        if (q) {
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { title: { contains: q, mode: "insensitive" } },
                        { joinUrl: { contains: q, mode: "insensitive" } },
                    ],
                },
            ];
        }

        if (range === "upcoming") {
            where.AND = [
                ...(where.AND || []),
                { startAt: { gte: now } },
                { status: { not: "canceled" } },
            ];
        } else if (range === "past") {
            where.AND = [
                ...(where.AND || []),
                {
                    OR: [
                        { endAt: { lt: now } },
                        { AND: [{ endAt: null }, { startAt: { lt: now } }] },
                    ],
                },
            ];
        }

        const [items, total] = await Promise.all([
            prisma.session.findMany({
                where,
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
                orderBy: [{ startAt: "desc" }, { id: "desc" }],
                take,
                skip,
            }),
            prisma.session.count({ where }),
        ]);

        // Shape response with participant info
        const shaped = items.map((s) => {
            const activeParticipants = (s.participants || []).filter(
                (p) => p.status !== "canceled"
            );
            return {
                ...s,
                participantCount: activeParticipants.length,
                learners:
                    s.type === "GROUP"
                        ? activeParticipants.map((p) => ({
                            ...p.user,
                            status: p.status,
                        }))
                        : s.user
                            ? [{ ...s.user, status: "booked" }]
                            : [],
            };
        });

        res.json({ items: shaped, total });
    } catch (err) {
        logger.error({ err }, "admin.sessions.list error");
        res.status(500).json({ error: "Failed to load sessions" });
    }
});

// --------------------------------------------------------------------------
// POST /api/admin/sessions - Create new session (1:1 or GROUP)
// --------------------------------------------------------------------------
router.post("/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
    let idempotency = null;

    try {
        const {
            type = "ONE_ON_ONE",
            learnerId,
            learnerIds,
            teacherId,
            capacity,
            title = "Lesson",
            startAt,
            durationMin,
            endAt,
            joinUrl,
            meetingUrl,
            notes,
            allowNoCredit = false,
        } = req.body;

        if (!startAt) {
            return res.status(400).json({ error: "startAt is required" });
        }

        const start = new Date(startAt);
        if (Number.isNaN(start.getTime())) {
            return res.status(400).json({ error: "Invalid startAt datetime" });
        }

        const finalEndAt = endAt
            ? new Date(endAt)
            : new Date(start.getTime() + Number(durationMin || 60) * 60_000);

        const finalJoinUrl = (joinUrl ?? meetingUrl ?? "").trim() || null;
        const finalNotes = (notes ?? "").trim() || null;

        // ─────────────────────────────────────────────
        // VALIDATION: Ensure teacher is valid and not the same as learner
        // ─────────────────────────────────────────────
        if (teacherId) {
            const teacher = await prisma.user.findUnique({
                where: { id: Number(teacherId) },
                select: { id: true, role: true, isDisabled: true },
            });

            if (!teacher || teacher.isDisabled) {
                return res.status(404).json({
                    error: "Teacher not found or disabled",
                    teacherId: Number(teacherId),
                });
            }

            if (teacher.role !== "teacher" && teacher.role !== "admin") {
                return res.status(400).json({
                    error: "teacherId must refer to a teacher or admin",
                    teacherId: Number(teacherId),
                    actualRole: teacher.role,
                });
            }
        }

        // ─────────────────────────────────────────────
        // ONE_ON_ONE SESSION
        // ─────────────────────────────────────────────
        if (type === "ONE_ON_ONE") {
            if (!learnerId) {
                return res.status(400).json({ error: "learnerId is required" });
            }

            const learner = await prisma.user.findUnique({
                where: { id: Number(learnerId) },
                select: { id: true, role: true, isDisabled: true },
            });

            if (!learner || learner.isDisabled) {
                return res.status(404).json({
                    error: "User not found or disabled",
                    userId: Number(learnerId),
                });
            }
            if (learner.role !== "learner" && learner.role !== "admin") {
                return res.status(400).json({
                    error: "learnerId must refer to a learner",
                    userId: Number(learnerId),
                });
            }

            // ✅ VALIDATION: Prevent teacher from being assigned as learner
            if (teacherId && Number(teacherId) === Number(learnerId)) {
                return res.status(400).json({
                    error: "Teacher cannot be the same as learner",
                    teacherId: Number(teacherId),
                    learnerId: Number(learnerId),
                });
            }

            // Conflict check
            const conflicts = await findSessionConflicts({
                startAt: start,
                endAt: finalEndAt,
                userId: Number(learnerId),
                teacherId,
            });

            if (conflicts.length) {
                return res.status(409).json({ error: "Time conflict", conflicts });
            }

            // Credit check
            const remaining = await getRemainingCredits(Number(learnerId));
            if (!allowNoCredit && remaining <= 0) {
                return res.status(422).json({
                    error: "no_credits",
                    message: "Learner has no remaining credits",
                    learnerId: Number(learnerId),
                });
            }

            idempotency = await beginIdempotentRequest({
                actorId: req.user.id,
                scope: "admin.sessions.create",
                key: getIdempotencyKeyFromRequest(req),
                payload: {
                    type: "ONE_ON_ONE",
                    learnerId: Number(learnerId),
                    teacherId: teacherId ? Number(teacherId) : null,
                    title,
                    startAt: start.toISOString(),
                    endAt: finalEndAt.toISOString(),
                    joinUrl: finalJoinUrl,
                    notes: finalNotes,
                    allowNoCredit: !!allowNoCredit,
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

            const session = await prisma.session.create({
                data: {
                    type: "ONE_ON_ONE",
                    userId: Number(learnerId),
                    teacherId: teacherId || null,
                    title,
                    startAt: start,
                    endAt: finalEndAt,
                    joinUrl: finalJoinUrl,
                    notes: finalNotes,
                },
            });

            // Also create participant row for consistency
            await prisma.sessionParticipant.create({
                data: {
                    sessionId: session.id,
                    userId: Number(learnerId),
                },
            });

            // Consume credit on booking (not on completion)
            let creditResult = null;
            console.log("========== CREDIT DEBUG ==========");
            console.log("learnerId:", Number(learnerId));
            console.log(
                "allowNoCredit:",
                allowNoCredit,
                "type:",
                typeof allowNoCredit
            );
            if (!allowNoCredit) {
                console.log(">>> ENTERING credit consumption");
                try {
                    creditResult = await consumeOneCredit(Number(learnerId));
                    console.log(
                        ">>> consumeOneCredit result:",
                        JSON.stringify(creditResult)
                    );
                    if (!creditResult.ok) {
                        logger.warn(
                            { userId: Number(learnerId), sessionId: session.id },
                            "[credits] Failed to consume credit on booking"
                        );
                    }
                } catch (e) {
                    console.log(">>> EXCEPTION:", e.message);
                    logger.error(
                        { err: e, userId: Number(learnerId), sessionId: session.id },
                        "[credits] consumeOneCredit failed on session create"
                    );
                }
            } else {
                console.log(">>> SKIPPED - allowNoCredit is truthy");
            }
            console.log("========== END DEBUG ==========");

            await audit(req.user.id, "session_create", "Session", session.id, {
                type: "ONE_ON_ONE",
                learnerId: Number(learnerId),
                teacherId,
                creditConsumed: creditResult?.ok || false,
            });

            // ✅ Send booking notifications (in-app + email) to learner AND teacher
            try {
                await sendBookingNotifications({
                    session,
                    learnerIds: [Number(learnerId)],
                    teacherId: teacherId || null,
                    bookedBy: req.user.id,
                });
            } catch (e) {
                logger.error(
                    { err: e, learnerId: Number(learnerId), sessionId: session.id },
                    "booking notifications failed"
                );
            }

            const responseBody = { ok: true, session };
            if (idempotency?.state === "started") {
                await completeIdempotentRequest(idempotency.recordId, {
                    statusCode: 201,
                    responseBody,
                    resourceId: session.id,
                });
            }

            return res.status(201).json(responseBody);
        }

        // ─────────────────────────────────────────────
        // GROUP SESSION
        // ─────────────────────────────────────────────
        if (!Array.isArray(learnerIds) || learnerIds.length === 0) {
            return res
                .status(400)
                .json({ error: "learnerIds[] is required for GROUP sessions" });
        }

        const uniqueLearnerIds = Array.from(
            new Set(
                learnerIds.map((x) => Number(x)).filter((n) => n && !Number.isNaN(n))
            )
        );

        if (!uniqueLearnerIds.length) {
            return res
                .status(400)
                .json({ error: "learnerIds[] must contain valid ids" });
        }

        // ✅ VALIDATION: Prevent teacher from being in learnerIds
        if (teacherId && uniqueLearnerIds.includes(Number(teacherId))) {
            return res.status(400).json({
                error: "Teacher cannot be a participant in the same session",
                teacherId: Number(teacherId),
            });
        }

        if (capacity && uniqueLearnerIds.length > capacity) {
            return res.status(400).json({
                error: "capacity_exceeded",
                message: "learnerIds exceed session capacity",
            });
        }

        // Validate users + conflicts + credits PER learner
        for (const uid of uniqueLearnerIds) {
            const u = await prisma.user.findUnique({
                where: { id: uid },
                select: { id: true, role: true, isDisabled: true },
            });

            if (!u || u.isDisabled) {
                return res
                    .status(404)
                    .json({ error: "User not found or disabled", learnerId: uid });
            }
            if (u.role !== "learner" && u.role !== "admin") {
                return res
                    .status(400)
                    .json({ error: "learnerIds must refer to learners", learnerId: uid });
            }

            const conflicts = await findSessionConflicts({
                startAt: start,
                endAt: finalEndAt,
                userId: uid,
                teacherId,
            });

            if (conflicts.length) {
                return res.status(409).json({
                    error: "Time conflict",
                    learnerId: uid,
                    conflicts,
                });
            }

            const remaining = await getRemainingCredits(uid);
            if (!allowNoCredit && remaining <= 0) {
                return res.status(422).json({
                    error: "no_credits",
                    learnerId: uid,
                });
            }
        }

        idempotency = await beginIdempotentRequest({
            actorId: req.user.id,
            scope: "admin.sessions.create",
            key: getIdempotencyKeyFromRequest(req),
            payload: {
                type: "GROUP",
                learnerIds: uniqueLearnerIds,
                teacherId: teacherId ? Number(teacherId) : null,
                capacity: capacity || null,
                title,
                startAt: start.toISOString(),
                endAt: finalEndAt.toISOString(),
                joinUrl: finalJoinUrl,
                notes: finalNotes,
                allowNoCredit: !!allowNoCredit,
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

        const session = await prisma.session.create({
            data: {
                type: "GROUP",
                capacity: capacity || null,
                teacherId: teacherId || null,
                title,
                startAt: start,
                endAt: finalEndAt,
                joinUrl: finalJoinUrl,
                notes: finalNotes,
                // No userId for GROUP sessions
            },
        });

        await prisma.sessionParticipant.createMany({
            data: uniqueLearnerIds.map((uid) => ({
                sessionId: session.id,
                userId: uid,
            })),
            skipDuplicates: true,
        });

        // Consume credit for each learner on booking (not on completion)
        const creditResults = [];
        if (!allowNoCredit) {
            for (const uid of uniqueLearnerIds) {
                try {
                    const result = await consumeOneCredit(uid);
                    creditResults.push({ learnerId: uid, consumed: result.ok });
                    if (!result.ok) {
                        logger.warn(
                            { userId: uid, sessionId: session.id },
                            "[credits] Failed to consume credit on GROUP booking"
                        );
                    }
                } catch (e) {
                    logger.error(
                        { err: e, userId: uid, sessionId: session.id },
                        "[credits] consumeOneCredit failed on GROUP session create"
                    );
                    creditResults.push({ learnerId: uid, consumed: false });
                }
            }
        }

        await audit(req.user.id, "session_create", "Session", session.id, {
            type: "GROUP",
            learnerIds: uniqueLearnerIds,
            teacherId,
            capacity,
            creditResults,
        });

        // ✅ Send booking notifications (in-app + email) to all learners AND teacher
        try {
            await sendBookingNotifications({
                session,
                learnerIds: uniqueLearnerIds,
                teacherId: teacherId || null,
                bookedBy: req.user.id,
            });
        } catch (e) {
            logger.error(
                { err: e, learnerIds: uniqueLearnerIds, sessionId: session.id },
                "booking notifications failed (group)"
            );
        }

        const responseBody = { ok: true, session };
        if (idempotency?.state === "started") {
            await completeIdempotentRequest(idempotency.recordId, {
                statusCode: 201,
                responseBody,
                resourceId: session.id,
            });
        }

        return res.status(201).json(responseBody);
    } catch (e) {
        if (idempotency?.state === "started") {
            await abandonIdempotentRequest(idempotency.recordId);
        }
        logger.error({ err: e }, "admin.createSession error");
        return res.status(500).json({ error: "Failed to create session" });
    }
});

// --------------------------------------------------------------------------
// POST /api/admin/sessions/:id/participants - Add participants to GROUP session
// --------------------------------------------------------------------------
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

            // Deduplicate + remove already-active participants
            const toAdd = ids.filter((uid) => {
                const st = existing.get(uid);
                return !st || st === "canceled";
            });

            if (!toAdd.length) {
                return res.json({ ok: true, added: 0, alreadyInSession: ids });
            }

            // Capacity check (count non-canceled)
            const activeCount = (session.participants || []).filter(
                (p) => p.status !== "canceled"
            ).length;
            const nextCount = activeCount + toAdd.length;

            if (
                !allowOverCapacity &&
                session.capacity &&
                nextCount > session.capacity
            ) {
                return res.status(400).json({
                    error: "capacity_exceeded",
                    message: "Adding these learners exceeds session capacity",
                    capacity: session.capacity,
                    activeCount,
                    attemptingToAdd: toAdd.length,
                });
            }

            // Validate each learner: exists + enabled + conflicts + credits
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

            // Insert/update participant rows
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

            // Consume credit for each added learner on booking (not on completion)
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

            await audit(
                req.user.id,
                "session_add_participants",
                "Session",
                sessionId,
                {
                    addedUserIds: toAdd,
                    creditResults,
                }
            );

            // ✅ Send booking notifications to newly added participants
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

// --------------------------------------------------------------------------
// DELETE /api/admin/sessions/:id/participants/:userId - Remove participant
// --------------------------------------------------------------------------
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

            const row = (session.participants || []).find(
                (p) => p.userId === targetUserId
            );
            if (!row)
                return res
                    .status(404)
                    .json({ error: "Participant not found in session" });

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

            await audit(
                req.user.id,
                "session_remove_participant",
                "Session",
                sessionId,
                {
                    removedUserId: targetUserId,
                    refunded,
                }
            );

            return res.json({ ok: true, removed: true, refunded });
        } catch (e) {
            logger.error({ err: e }, "admin.sessions.removeParticipant error");
            return res.status(500).json({ error: "Failed to remove participant" });
        }
    }
);

// --------------------------------------------------------------------------
// PATCH /api/admin/sessions/:id - Update session
// --------------------------------------------------------------------------
router.patch(
    "/admin/sessions/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
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

            // Backward-compat: admin UI sends meetingUrl, but DB field is joinUrl
            if (patch.joinUrl === undefined && req.body.meetingUrl !== undefined) {
                patch.joinUrl = req.body.meetingUrl;
            }

            // Normalize simple string fields
            if (patch.joinUrl !== undefined) {
                patch.joinUrl = String(patch.joinUrl || "").trim() || null;
            }
            if (patch.notes !== undefined) {
                patch.notes = String(patch.notes || "").trim() || null;
            }

            // Validate time/user changes for conflicts
            const start = patch.startAt ? new Date(patch.startAt) : existing.startAt;
            const end = patch.endAt ? new Date(patch.endAt) : existing.endAt;
            const teacherId =
                patch.teacherId !== undefined
                    ? Number(patch.teacherId)
                    : existing.teacherId;

            if (patch.startAt || patch.endAt || patch.teacherId) {
                // Check conflicts for ALL participants if GROUP
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
                    // ONE_ON_ONE
                    const userId =
                        patch.userId !== undefined ? Number(patch.userId) : existing.userId;

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

            // Type conversions
            if (patch.userId !== undefined)
                patch.userId = Number(patch.userId) || null;
            if (patch.teacherId !== undefined)
                patch.teacherId = Number(patch.teacherId) || null;
            if (patch.capacity !== undefined)
                patch.capacity = Number(patch.capacity) || null;
            if (patch.startAt !== undefined) patch.startAt = new Date(patch.startAt);
            if (patch.endAt !== undefined)
                patch.endAt = patch.endAt ? new Date(patch.endAt) : null;

            const prevStatus = existing.status;
            const nextStatus = patch.status ?? existing.status;

            // Credits are consumed on booking, not on completion
            // Only refund when transitioning TO canceled status
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

            // Handle credit refund when canceling via admin PATCH
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
                    // ONE_ON_ONE
                    const learnerId =
                        existing.userId ||
                        (existing.participants?.length
                            ? existing.participants[0].userId
                            : null);

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

            // Shape response
            const activeParticipants = (updated.participants || []).filter(
                (p) => p.status !== "canceled"
            );

            res.json({
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
            res.status(500).json({ error: "Failed to update session" });
        }
    }
);

// --------------------------------------------------------------------------
// DELETE /api/admin/sessions/:id - Delete session
// --------------------------------------------------------------------------
router.delete(
    "/admin/sessions/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
        try {
            const id = Number(req.params.id);
            await prisma.session.delete({ where: { id } });
            await audit(req.user.id, "session_delete", "Session", id);
            res.json({ ok: true });
        } catch (err) {
            logger.error({ err }, "admin.sessions.delete error");
            res.status(500).json({ error: "Failed to delete session" });
        }
    }
);

// --------------------------------------------------------------------------
// POST /api/admin/sessions/bulk - Bulk session operations
// Body: { ids: number[], action: "delete" | "cancel" | "assign-teacher", teacherId?: number }
// --------------------------------------------------------------------------
router.post(
    "/admin/sessions/bulk",
    requireAuth,
    requireAdmin,
    async (req, res) => {
        try {
            const { ids, action, teacherId } = req.body;

            // Validate input
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

            // Fetch sessions to operate on
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

            // Process each session
            for (const session of sessions) {
                try {
                    if (action === "delete") {
                        // Hard delete
                        await prisma.session.delete({ where: { id: session.id } });
                        await audit(req.user.id, "session_delete", "Session", session.id, { bulk: true });
                        affected++;

                    } else if (action === "cancel") {
                        // Only cancel if not already canceled
                        if (session.status !== "canceled") {
                            await prisma.session.update({
                                where: { id: session.id },
                                data: { status: "canceled" },
                            });

                            // Refund credits
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
                                // ONE_ON_ONE
                                const learnerId = session.userId ||
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
                        // Validate teacher exists
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

            res.json({
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
            res.status(500).json({ error: "Failed to perform bulk operation" });
        }
    }
);

export default router;
