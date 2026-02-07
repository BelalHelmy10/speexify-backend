// src/routes/sessions/learner.js
// Learner session endpoints: /me/sessions, /me/sessions-between, /me/progress

import {
    Router,
    prisma,
    requireAuth,
    finalizeExpiredSessionsForUser,
    logger,
} from "./_shared.js";

const router = Router();
const SESSION_LIST_DEFAULT_LIMIT = 10;
const SESSION_LIST_MAX_LIMIT = 100;
const SESSIONS_BETWEEN_DEFAULT_LIMIT = 500;
const SESSIONS_BETWEEN_MAX_LIMIT = 1000;

function parseBoundedInt(value, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// --------------------------------------------------------------------------
// GET /api/me/sessions - List sessions for current user
// --------------------------------------------------------------------------
router.get("/me/sessions", requireAuth, async (req, res) => {
    try {
        // ✅ Admin dashboard should not use "my sessions"
        // BUT allow if admin is impersonating another user
        if (req.user.role === "admin" && !req.session?.asUserId) {
            return res.json([]);
        }

        // Best-effort finalization, don't break if it fails
        try {
            await finalizeExpiredSessionsForUser(req.viewUserId);
        } catch (e) {
            logger.error(
                { err: e, userId: req.viewUserId },
                "finalizeExpiredSessionsForUser failed"
            );
        }

        const userId = req.viewUserId;
        // When impersonating, get the impersonated user's role, not admin's role
        const isImpersonating = !!req.session?.asUserId;
        let role = req.user.role || "learner";

        // If impersonating, fetch the impersonated user's role
        if (isImpersonating && req.session.asUserId) {
            const impersonatedUser = await prisma.user.findUnique({
                where: { id: req.session.asUserId },
                select: { role: true },
            });
            if (impersonatedUser) {
                role = impersonatedUser.role;
            }
        }
        const { range = "upcoming" } = req.query;
        const requestedLimit = parseBoundedInt(req.query.limit, {
            fallback: SESSION_LIST_DEFAULT_LIMIT,
            min: 1,
            max: SESSION_LIST_MAX_LIMIT,
        });
        const now = new Date();

        // Membership base: include both participants AND legacy userId
        const whereBase =
            role === "teacher"
                ? {
                    OR: [
                        { teacherId: userId },
                        { participants: { some: { userId } } },
                        { userId }, // legacy fallback
                    ],
                }
                : {
                    OR: [
                        { participants: { some: { userId } } },
                        { userId }, // legacy fallback
                    ],
                };

        const notCanceled = { status: { not: "canceled" } };

        const inProgressOrFuture = {
            OR: [
                { startAt: { gte: now } },
                {
                    AND: [
                        { startAt: { lte: now } },
                        { OR: [{ endAt: { gte: now } }, { endAt: null }] },
                    ],
                },
            ],
        };

        const pastCondition = {
            OR: [
                { endAt: { lt: now } },
                { AND: [{ endAt: null }, { startAt: { lt: now } }] },
            ],
        };

        const where =
            range === "past"
                ? { AND: [whereBase, pastCondition] }
                : { AND: [whereBase, notCanceled, inProgressOrFuture] };

        const orderBy = range === "past" ? { startAt: "desc" } : { startAt: "asc" };

        const rawSessions = await prisma.session.findMany({
            where,
            orderBy,
            take: requestedLimit,
            select: {
                id: true,
                title: true,
                startAt: true,
                endAt: true,
                joinUrl: true,
                status: true,
                type: true,
                capacity: true,
                teacherId: true,
                userId: true,
                teacher: { select: { id: true, name: true, email: true } },
                user: { select: { id: true, name: true, email: true } },
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        user: { select: { id: true, name: true, email: true } },
                    },
                },
                teacherFeedbackMessageToLearner: true,
                teacherFeedbackComments: true,
                teacherFeedbackFutureSteps: true,
                feedback: { select: { id: true } },
            },
        });

        const sessions = rawSessions.map((s) => {
            const hasFeedback =
                !!s.feedback ||
                !!s.teacherFeedbackMessageToLearner ||
                !!s.teacherFeedbackComments ||
                !!s.teacherFeedbackFutureSteps;

            const teacherFeedback = hasFeedback
                ? {
                    messageToLearner: s.teacherFeedbackMessageToLearner || "",
                    commentsOnSession: s.teacherFeedbackComments || "",
                    futureSteps: s.teacherFeedbackFutureSteps || "",
                }
                : null;

            const {
                teacherFeedbackMessageToLearner,
                teacherFeedbackComments,
                teacherFeedbackFutureSteps,
                feedback,
                ...rest
            } = s;

            const activeParticipants = (rest.participants || []).filter(
                (p) => p.status !== "canceled"
            );

            return {
                ...rest,
                participantCount: activeParticipants.length,
                // For GROUP sessions, include learner list
                learners:
                    rest.type === "GROUP"
                        ? activeParticipants.map((p) => p.user)
                        : rest.user
                            ? [rest.user]
                            : [],
                teacherFeedback,
                hasFeedback,
            };
        });

        res.json(sessions);
    } catch (e) {
        logger.error({ err: e }, "GET /me/sessions failed");
        res.status(500).json({ error: "Failed to load sessions" });
    }
});

// --------------------------------------------------------------------------
// GET /api/me/sessions-between - Get sessions in date range (calendar)
// --------------------------------------------------------------------------
router.get("/me/sessions-between", requireAuth, async (req, res) => {
    try {
        const startParam = String(req.query.start || "");
        const endParam = String(req.query.end || "");
        const includeCanceled = String(req.query.includeCanceled || "") === "true";

        const startAt = new Date(startParam);
        const endAt = new Date(endParam);

        if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
            return res.status(400).json({ error: "Invalid date range" });
        }

        const userId = req.viewUserId;

        // When impersonating, get the impersonated user's role, not admin's role
        const isImpersonating = !!req.session?.asUserId;
        let role = req.user.role || "learner";

        if (isImpersonating && req.session.asUserId) {
            const impersonatedUser = await prisma.user.findUnique({
                where: { id: req.session.asUserId },
                select: { role: true },
            });
            if (impersonatedUser) {
                role = impersonatedUser.role;
            }
        }

        const whereBase =
            role === "teacher"
                ? {
                    OR: [
                        { teacherId: userId },
                        { participants: { some: { userId } } },
                        { userId }, // legacy
                    ],
                }
                : {
                    OR: [{ participants: { some: { userId } } }, { userId }],
                };

        const where = {
            AND: [
                whereBase,
                includeCanceled ? {} : { status: { not: "canceled" } },
                { startAt: { lte: endAt } },
                { OR: [{ endAt: { gte: startAt } }, { endAt: null }] },
            ],
        };

        const requestedLimit = parseBoundedInt(req.query.limit, {
            fallback: SESSIONS_BETWEEN_DEFAULT_LIMIT,
            min: 1,
            max: SESSIONS_BETWEEN_MAX_LIMIT,
        });

        const sessions = await prisma.session.findMany({
            where,
            orderBy: { startAt: "asc" },
            take: requestedLimit,
            select: {
                id: true,
                title: true,
                startAt: true,
                endAt: true,
                joinUrl: true,
                status: true,
                type: true,
                capacity: true,
                feedback: { select: { id: true } },
                participants: {
                    select: { userId: true, status: true },
                },
            },
        });

        const shaped = sessions.map((s) => {
            const activeCount = (s.participants || []).filter(
                (p) => p.status !== "canceled"
            ).length;

            return {
                ...s,
                participantCount: activeCount,
                teacherFeedback: s.feedback,
            };
        });

        return res.json({
            sessions: shaped,
            truncated: sessions.length === requestedLimit,
        });
    } catch (e) {
        logger.error({ err: e }, "GET /me/sessions-between failed");
        return res.status(500).json({
            error: e?.message || e?.meta?.cause || "Failed to load calendar sessions",
        });
    }
});

// --------------------------------------------------------------------------
// GET /api/me/progress - Learner progress summary
// --------------------------------------------------------------------------
router.get("/me/progress", requireAuth, async (req, res) => {
    try {
        const userId = req.viewUserId || req.user.id;

        const completedSessions = await prisma.session.findMany({
            where: {
                status: "completed",
                OR: [{ participants: { some: { userId } } }, { userId }], // legacy
            },
            orderBy: { startAt: "asc" },
            select: {
                id: true,
                startAt: true,
                endAt: true,
            },
        });

        const totalCompletedSessions = completedSessions.length;

        let totalMinutes = 0;
        const monthCounts = new Map();

        for (const s of completedSessions) {
            const start = s.startAt ? new Date(s.startAt) : null;
            const end = s.endAt ? new Date(s.endAt) : null;

            if (
                start &&
                end &&
                !Number.isNaN(start.getTime()) &&
                !Number.isNaN(end.getTime())
            ) {
                const diffMs = end.getTime() - start.getTime();
                if (diffMs > 0) {
                    totalMinutes += diffMs / 1000 / 60;
                }
            }

            if (start && !Number.isNaN(start.getTime())) {
                const year = start.getFullYear();
                const month = String(start.getMonth() + 1).padStart(2, "0");
                const key = `${year}-${month}`;
                monthCounts.set(key, (monthCounts.get(key) || 0) + 1);
            }
        }

        const totalHours = Number((totalMinutes / 60).toFixed(1));

        const timeline = Array.from(monthCounts.entries())
            .map(([month, count]) => ({ month, count }))
            .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0))
            .slice(-12);

        return res.json({
            summary: {
                totalCompletedSessions,
                totalMinutes: Math.round(totalMinutes),
                totalHours,
                averageRating: null,
            },
            timeline,
        });
    } catch (err) {
        logger.error({ err }, "GET /me/progress failed");
        return res
            .status(500)
            .json({ error: err?.message || "Failed to load progress" });
    }
});

export default router;
