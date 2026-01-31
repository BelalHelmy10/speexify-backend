// src/routes/sessions/crud.js
// Session list and get single session endpoints

import { Router, prisma, requireAuth, logger } from "./_shared.js";

const router = Router();

// --------------------------------------------------------------------------
// GET /api/sessions - List sessions for current user (learner view)
// FIX: Include both participants AND legacy userId field
// --------------------------------------------------------------------------
router.get("/sessions", requireAuth, async (req, res) => {
    try {
        const userId = req.viewUserId;

        const sessions = await prisma.session.findMany({
            where: {
                // FIX: Check BOTH participant membership AND legacy userId
                OR: [{ participants: { some: { userId } } }, { userId }],
            },
            include: {
                teacher: { select: { id: true, name: true, email: true } },
                user: { select: { id: true, name: true, email: true } }, // Legacy learner
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        user: { select: { id: true, name: true, email: true } },
                    },
                },
            },
            orderBy: { startAt: "asc" },
        });

        res.json(sessions);
    } catch (err) {
        logger.error({ err }, "GET /sessions failed");
        res.status(500).json({ error: "Failed to load sessions" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id - Get single session details
// --------------------------------------------------------------------------
router.get("/sessions/:id", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id || Number.isNaN(id)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id },
            include: {
                user: { select: { id: true, name: true, email: true } }, // Legacy 1:1 learner
                teacher: { select: { id: true, name: true, email: true } },
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        attendedAt: true,
                        user: { select: { id: true, name: true, email: true } },
                    },
                },
                feedback: true, // FIX: Use correct relation name
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );

        // Permission: learner participant OR legacy owner OR teacher OR admin
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        // Build teacher feedback from either new relation or legacy fields
        const feedbackFromRelation = session.feedback;
        const hasLegacyFeedback =
            !!session.teacherFeedbackMessageToLearner ||
            !!session.teacherFeedbackComments ||
            !!session.teacherFeedbackFutureSteps;

        const teacherFeedback = feedbackFromRelation
            ? {
                messageToLearner: feedbackFromRelation.messageToLearner || "",
                commentsOnSession: feedbackFromRelation.commentsOnSession || "",
                futureSteps: feedbackFromRelation.futureSteps || "",
            }
            : hasLegacyFeedback
                ? {
                    messageToLearner: session.teacherFeedbackMessageToLearner || "",
                    commentsOnSession: session.teacherFeedbackComments || "",
                    futureSteps: session.teacherFeedbackFutureSteps || "",
                }
                : null;

        // Calculate participant info
        const activeParticipants = (session.participants || []).filter(
            (p) => p.status !== "canceled"
        );

        const shaped = {
            ...session,
            isLearner,
            isTeacher,
            isAdmin,
            teacherFeedback,
            participantCount: activeParticipants.length,
            // For GROUP sessions, list all learners
            learners:
                session.type === "GROUP"
                    ? activeParticipants.map((p) => ({
                        ...p.user,
                        status: p.status,
                        attendedAt: p.attendedAt,
                    }))
                    : session.user
                        ? [{ ...session.user, status: "booked" }]
                        : [],
        };

        // Remove redundant fields from response
        delete shaped.teacherFeedbackMessageToLearner;
        delete shaped.teacherFeedbackComments;
        delete shaped.teacherFeedbackFutureSteps;

        return res.json({ session: shaped });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id failed");
        return res.status(500).json({ error: "Failed to load session" });
    }
});

export default router;
