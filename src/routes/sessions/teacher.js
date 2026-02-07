// src/routes/sessions/teacher.js
// Teacher session list endpoint

import {
    Router,
    prisma,
    requireAuth,
    finalizeExpiredSessionsForTeacher,
    logger,
} from "./_shared.js";

const router = Router();
const TEACHER_SESSIONS_DEFAULT_LIMIT = 120;
const TEACHER_SESSIONS_MAX_LIMIT = 300;
const TEACHER_SESSIONS_MAX_OFFSET = 5000;

function parseBoundedInt(value, { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(parsed)));
}

// --------------------------------------------------------------------------
// GET /api/teacher/sessions - List sessions for teacher
// --------------------------------------------------------------------------
router.get("/teacher/sessions", requireAuth, async (req, res) => {
    try {
        const teacherId = req.viewUserId;
        const range = String(req.query.range || "all").toLowerCase();
        const take = parseBoundedInt(req.query.limit, {
            fallback: TEACHER_SESSIONS_DEFAULT_LIMIT,
            min: 1,
            max: TEACHER_SESSIONS_MAX_LIMIT,
        });
        const skip = parseBoundedInt(req.query.offset, {
            fallback: 0,
            min: 0,
            max: TEACHER_SESSIONS_MAX_OFFSET,
        });
        const now = new Date();

        // Finalize any expired sessions first
        try {
            await finalizeExpiredSessionsForTeacher(teacherId);
        } catch (e) {
            logger.error(
                { err: e, teacherId },
                "finalizeExpiredSessionsForTeacher failed"
            );
        }

        const where = { teacherId };
        if (range === "upcoming") {
            where.AND = [
                {
                    OR: [
                        { startAt: { gte: now } },
                        {
                            AND: [
                                { startAt: { lte: now } },
                                { OR: [{ endAt: { gte: now } }, { endAt: null }] },
                            ],
                        },
                    ],
                },
                { status: { not: "canceled" } },
            ];
        } else if (range === "past") {
            where.OR = [
                { endAt: { lt: now } },
                { AND: [{ endAt: null }, { startAt: { lt: now } }] },
            ];
        }

        const sessions = await prisma.session.findMany({
            where,
            select: {
                id: true,
                title: true,
                startAt: true,
                endAt: true,
                notes: true,
                type: true,
                capacity: true,
                userId: true,
                teacherId: true,
                status: true,
                joinUrl: true,
                feedbackScore: true,
                createdAt: true,
                updatedAt: true,
                user: { select: { id: true, email: true, name: true } },
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        attendedAt: true,
                        user: { select: { id: true, email: true, name: true } },
                    },
                },
            },
            orderBy: [
                { startAt: range === "past" ? "desc" : "asc" },
                { id: range === "past" ? "desc" : "asc" },
            ],
            take,
            skip,
        });

        // Shape response with participant counts
        const shaped = sessions.map((s) => {
            const activeParticipants = (s.participants || []).filter(
                (p) => p.status !== "canceled"
            );
            return {
                ...s,
                participantCount: activeParticipants.length,
                // For GROUP sessions, provide a learners array
                learners:
                    s.type === "GROUP"
                        ? activeParticipants.map((p) => p.user)
                        : s.user
                            ? [s.user]
                            : [],
            };
        });

        res.json(shaped);
    } catch (e) {
        logger.error({ err: e }, "GET /teacher/sessions failed");
        res.status(500).json({ error: "Failed to load teacher sessions" });
    }
});

export default router;
