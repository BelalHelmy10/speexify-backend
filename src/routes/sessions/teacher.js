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

// --------------------------------------------------------------------------
// GET /api/teacher/sessions - List sessions for teacher
// --------------------------------------------------------------------------
router.get("/teacher/sessions", requireAuth, async (req, res) => {
    try {
        const teacherId = req.viewUserId;

        // Finalize any expired sessions first
        try {
            await finalizeExpiredSessionsForTeacher(teacherId);
        } catch (e) {
            logger.error(
                { err: e, teacherId },
                "finalizeExpiredSessionsForTeacher failed"
            );
        }

        const sessions = await prisma.session.findMany({
            where: { teacherId },
            include: {
                // Legacy 1:1 learner (may be null for group)
                user: { select: { id: true, email: true, name: true } },
                // Group learners
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        attendedAt: true,
                        user: { select: { id: true, email: true, name: true } },
                    },
                },
            },
            orderBy: { startAt: "asc" },
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
