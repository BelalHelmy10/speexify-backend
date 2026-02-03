// src/routes/sessions/bulk-create.js
// Bulk create recurring weekly sessions for a learner

import {
    Router,
    prisma,
    requireAuth,
    requireAdmin,
    findSessionConflicts,
    getRemainingCredits,
    consumeOneCredit,
    sendBookingNotifications,
    logger
} from "./_shared.js";

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
        } = req.body;

        // Validation
        if (!learnerId) {
            return res.status(400).json({ error: "learnerId is required" });
        }
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
        const today = new Date();
        let currentDate = new Date(today);

        // Find the next occurrence of the selected day
        while (currentDate.getDay() !== Number(dayOfWeek)) {
            currentDate.setDate(currentDate.getDate() + 1);
        }

        // Generate dates for each session
        for (let i = 0; i < numberOfSessions; i++) {
            const sessionDate = new Date(currentDate);
            sessionDates.push(sessionDate);
            currentDate.setDate(currentDate.getDate() + 7); // Add 7 days for next week
        }

        // Check credits upfront
        const creditsAvailable = await getRemainingCredits(Number(learnerId));
        if (!allowNoCredit && creditsAvailable < numberOfSessions) {
            return res.status(400).json({
                error: "insufficient_credits",
                creditsAvailable,
                sessionsRequested: numberOfSessions,
            });
        }

        // Build session start times and check for conflicts
        const sessionsToCreate = [];
        const conflicts = [];

        for (let i = 0; i < sessionDates.length; i++) {
            const sessionDate = sessionDates[i];
            const [hours, minutes] = time.split(":").map(Number);

            const startAt = new Date(sessionDate);
            startAt.setHours(hours, minutes, 0, 0);

            const endAt = new Date(startAt);
            endAt.setMinutes(endAt.getMinutes() + Number(durationMin));

            // Check for conflicts
            const conflictList = await findSessionConflicts({
                learnerId: Number(learnerId),
                teacherId: teacherId ? Number(teacherId) : null,
                startAt,
                endAt,
            });

            // Determine title for this specific session
            const sessionTitle = (customTitles[i] || defaultTitle || "Lesson").trim();

            if (conflictList.length > 0) {
                conflicts.push({
                    date: sessionDate.toISOString().split("T")[0],
                    startAt: startAt.toISOString(),
                    conflicts: conflictList,
                });
            } else {
                sessionsToCreate.push({
                    type: "ONE_ON_ONE",
                    title: sessionTitle,
                    learnerId: Number(learnerId),
                    teacherId: teacherId ? Number(teacherId) : null,
                    startAt,
                    endAt,
                    durationMin: Number(durationMin),
                    status: "scheduled",
                    createdBy: req.user.id,
                });
            }
        }

        // If there are conflicts, return error
        if (conflicts.length > 0) {
            return res.status(409).json({
                error: "time_conflict",
                message: `Found conflicts on ${conflicts.length} date(s)`,
                conflicts,
            });
        }

        // Create all sessions in a transaction
        const createdSessions = await prisma.$transaction(async (tx) => {
            const results = [];

            for (const sessionData of sessionsToCreate) {
                // Create the session
                const session = await tx.session.create({
                    data: sessionData,
                    include: {
                        learner: { select: { id: true, name: true, email: true } },
                        teacher: { select: { id: true, name: true, email: true } },
                    },
                });

                results.push(session);
            }

            return results;
        });

        // Consume credits and send notifications for each session
        let creditsConsumed = 0;
        for (const session of createdSessions) {
            // Consume credit
            try {
                await consumeOneCredit(session.learnerId, session.id);
                creditsConsumed++;
            } catch (err) {
                if (!allowNoCredit) {
                    logger.warn({ sessionId: session.id }, "Failed to consume credit");
                }
            }

            // Send notifications
            try {
                await sendBookingNotifications(session);
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

        return res.status(201).json({
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
        });

    } catch (err) {
        logger.error({ err }, "bulk-create recurring sessions error");
        return res.status(500).json({ error: "Failed to create sessions" });
    }
});

export default bulkCreateRouter;
