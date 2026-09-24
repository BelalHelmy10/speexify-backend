// src/routes/sessions/bulk-create.js
// Bulk create recurring weekly sessions for a learner

import {
    Router,
    prisma,
    requireAuth,
    requireAdmin,
    findSessionConflictsWithClient,
    lockSchedulingResources,
    getRemainingCredits,
    consumeOneCreditWithClient,
    sendBookingNotifications,
    logger
} from "./_shared.js";
import {
    getIdempotencyKeyFromRequest,
    beginIdempotentRequest,
    completeIdempotentRequest,
    abandonIdempotentRequest,
} from "../../services/idempotencyService.js";

const bulkCreateRouter = Router();

/**
 * POST /api/admin/sessions/bulk-create
 * 
 * Create multiple recurring weekly sessions for a learner.
 * 
 * Body:
 * - learnerId: number (required)
 * - teacherId: number (optional)
 * - dayOfWeek: number (0-6, 0=Sunday) (required)
 * - time: string "HH:MM" (required)
 * - numberOfSessions: number (1-52) (required)
 * - durationMin: number (default 60)
 * - title: string (default "Lesson")
 * - allowNoCredit: boolean (default false)
 */
bulkCreateRouter.post("/admin/sessions/bulk-create", requireAuth, requireAdmin, async (req, res) => {
    let idempotency = null;

    try {
        const {
            learnerId,
            teacherId,
            dayOfWeek,
            time,
            numberOfSessions,
            durationMin = 60,
            defaultTitle = "Lesson",
            customTitles = [], // Array of titles corresponding to sessionDates
            allowNoCredit = false,
            startDate, // Optional: specific start date (YYYY-MM-DD)
        } = req.body;

        // Validation
        if (!learnerId) {
            return res.status(400).json({ error: "learnerId is required" });
        }
        // dayOfWeek is derived on frontend, but we still validate it loosely
        if (dayOfWeek === undefined || dayOfWeek < 0 || dayOfWeek > 6) {
            return res.status(400).json({ error: "dayOfWeek must be 0-6 (Sunday-Saturday)" });
        }
        if (!time || !/^\d{2}:\d{2}$/.test(time)) {
            return res.status(400).json({ error: "time must be in HH:MM format" });
        }
        if (!numberOfSessions || numberOfSessions < 1 || numberOfSessions > 52) {
            return res.status(400).json({ error: "numberOfSessions must be between 1 and 52" });
        }

        // Verify learner exists
        const learner = await prisma.user.findUnique({ where: { id: Number(learnerId) } });
        if (!learner) {
            return res.status(404).json({ error: "Learner not found" });
        }
        if (learner.role !== "learner") {
            return res.status(400).json({ error: "User is not a learner" });
        }

        // Verify teacher if provided
        if (teacherId) {
            const teacher = await prisma.user.findUnique({ where: { id: Number(teacherId) } });
            if (!teacher) {
                return res.status(404).json({ error: "Teacher not found" });
            }
            if (teacher.role !== "teacher" && teacher.role !== "admin") {
                return res.status(400).json({ error: "User is not a teacher" });
            }
        }

        // Generate session dates
        const sessionDates = [];
        let currentDate;

        if (startDate) {
            // Parse YYYY-MM-DD to local date object
            const [y, m, d] = startDate.split("-").map(Number);
            currentDate = new Date(y, m - 1, d);
        } else {
            // Legacy: Find next occurrence relative to today
            const today = new Date();
            currentDate = new Date(today);
            while (currentDate.getDay() !== Number(dayOfWeek)) {
                currentDate.setDate(currentDate.getDate() + 1);
            }
        }

        // Generate dates for each session
        for (let i = 0; i < numberOfSessions; i++) {
            const sessionDate = new Date(currentDate);
            sessionDates.push(sessionDate);
            currentDate.setDate(currentDate.getDate() + 7); // Add 7 days for next week
        }

        // Build session start times. Conflict checks happen again inside the
        // transaction after resource locks are held; a pre-transaction check
        // alone is racy across concurrent API instances.
        const sessionsToCreate = [];

        for (let i = 0; i < sessionDates.length; i++) {
            const sessionDate = sessionDates[i];
            const [hours, minutes] = time.split(":").map(Number);

            const startAt = new Date(sessionDate);
            startAt.setHours(hours, minutes, 0, 0);

            const endAt = new Date(startAt);
            endAt.setMinutes(endAt.getMinutes() + Number(durationMin));

            // Determine title for this specific session
            const sessionTitle = (customTitles[i] || defaultTitle || "Lesson").trim();
            sessionsToCreate.push({
                type: "ONE_ON_ONE",
                title: sessionTitle,
                userId: Number(learnerId),
                teacherId: teacherId ? Number(teacherId) : null,
                startAt,
                endAt,
                status: "scheduled",
            });
        }

        idempotency = await beginIdempotentRequest({
            actorId: req.user.id,
            scope: "admin.sessions.bulkCreate",
            key: getIdempotencyKeyFromRequest(req),
            payload: {
                learnerId: Number(learnerId),
                teacherId: teacherId ? Number(teacherId) : null,
                dayOfWeek: Number(dayOfWeek),
                time,
                numberOfSessions: Number(numberOfSessions),
                durationMin: Number(durationMin),
                defaultTitle,
                customTitles,
                allowNoCredit: !!allowNoCredit,
                startDate: startDate || null,
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

        // Create all sessions in a transaction
        const createdSessions = await prisma.$transaction(async (tx) => {
            const results = [];

            await lockSchedulingResources(tx, {
                learnerIds: [Number(learnerId)],
                teacherId: teacherId ? Number(teacherId) : null,
            });

            for (const sessionData of sessionsToCreate) {
                const conflictList = await findSessionConflictsWithClient(tx, {
                    userId: Number(learnerId),
                    teacherId: teacherId ? Number(teacherId) : null,
                    startAt: sessionData.startAt,
                    endAt: sessionData.endAt,
                });
                if (conflictList.length > 0) {
                    const error = new Error("A requested session overlaps an existing session");
                    error.statusCode = 409;
                    error.responseBody = {
                        error: "time_conflict",
                        message: "One or more requested sessions overlap an existing session",
                        conflicts: [{
                            date: sessionData.startAt.toISOString().split("T")[0],
                            startAt: sessionData.startAt.toISOString(),
                            conflicts: conflictList,
                        }],
                    };
                    throw error;
                }

                // Create the session
                const session = await tx.session.create({
                    data: sessionData,
                    include: {
                        user: { select: { id: true, name: true, email: true } },
                        teacher: { select: { id: true, name: true, email: true } },
                    },
                });

                if (!allowNoCredit) {
                    const debit = await consumeOneCreditWithClient(tx, session.userId, session.id);
                    if (!debit.ok) {
                        const error = new Error("Insufficient credits for all requested sessions");
                        error.statusCode = 400;
                        error.responseBody = {
                            error: "insufficient_credits",
                            message: "There are not enough credits for all requested sessions",
                        };
                        throw error;
                    }
                }
                results.push(session);
            }

            return results;
        });

        // Consume credits and send notifications for each session
        const creditsConsumed = allowNoCredit ? 0 : createdSessions.length;
        for (const session of createdSessions) {
            // Send notifications
            try {
                await sendBookingNotifications({
                    session,
                    learnerIds: [Number(learnerId)],
                    teacherId: session.teacherId || null,
                    bookedBy: req.user.id,
                });
            } catch (err) {
                logger.error({ err, sessionId: session.id }, "Failed to send notifications");
            }
        }

        // Get updated credit count
        const creditsAfter = await getRemainingCredits(Number(learnerId));

        logger.info({
            adminId: req.user.id,
            learnerId,
            created: createdSessions.length,
            creditsConsumed,
        }, "Bulk recurring sessions created");

        const responseBody = {
            success: true,
            created: createdSessions.length,
            creditsConsumed,
            creditsAfter,
            sessions: createdSessions.map((s) => ({
                id: s.id,
                date: s.startAt.toISOString().split("T")[0],
                startAt: s.startAt.toISOString(),
                title: s.title,
            })),
        };
        if (idempotency?.state === "started") {
            await completeIdempotentRequest(idempotency.recordId, {
                statusCode: 201,
                responseBody,
                resourceId: createdSessions[0]?.id || null,
            });
        }

        return res.status(201).json(responseBody);

    } catch (err) {
        if (idempotency?.state === "started") {
            await abandonIdempotentRequest(idempotency.recordId);
        }
        logger.error({ err }, "bulk-create recurring sessions error");
        if (err?.statusCode && err?.responseBody) {
            return res.status(err.statusCode).json(err.responseBody);
        }
        return res.status(500).json({
            error: "Failed to create sessions",
            details: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
});

export default bulkCreateRouter;
