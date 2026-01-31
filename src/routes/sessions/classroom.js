// src/routes/sessions/classroom.js
// Classroom experience endpoints: notes, resources, learner feedback, summary

import { Router, prisma, requireAuth, logger } from "./_shared.js";

const router = Router();

// --------------------------------------------------------------------------
// POST /api/sessions/:id/notes - Save/update teacher notes during session
// --------------------------------------------------------------------------
router.post("/sessions/:id/notes", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                status: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Only teacher or admin can save notes
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Only the teacher can save notes" });
        }

        const { notes } = req.body || {};
        const teacherNotes = typeof notes === "string" ? notes.slice(0, 10000) : "";

        const updated = await prisma.session.update({
            where: { id: sessionId },
            data: { teacherNotes },
            select: {
                id: true,
                teacherNotes: true,
                updatedAt: true,
            },
        });

        return res.json({ ok: true, session: updated });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/notes failed");
        return res.status(500).json({ error: "Failed to save notes" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/notes - Get teacher notes for a session
// --------------------------------------------------------------------------
router.get("/sessions/:id/notes", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                userId: true,
                teacherNotes: true,
                participants: { select: { userId: true } },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check permissions
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        return res.json({ notes: session.teacherNotes || "" });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/notes failed");
        return res.status(500).json({ error: "Failed to load notes" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/resources-used - Track resource usage during session
// --------------------------------------------------------------------------
router.post("/sessions/:id/resources-used", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const { resourceId, resourceTitle } = req.body || {};
        if (!resourceId) {
            return res.status(400).json({ error: "resourceId is required" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                status: true,
                resourcesUsed: true,
                resourcesUsedAt: true,
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Only teacher can track resources (they control what's shown)
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res
                .status(403)
                .json({ error: "Only the teacher can track resources" });
        }

        // Parse existing arrays
        let resourcesUsed = [];
        let resourcesUsedAt = {};

        try {
            resourcesUsed = Array.isArray(session.resourcesUsed)
                ? session.resourcesUsed
                : JSON.parse(session.resourcesUsed || "[]");
        } catch {
            resourcesUsed = [];
        }

        try {
            resourcesUsedAt =
                typeof session.resourcesUsedAt === "object" &&
                    session.resourcesUsedAt !== null
                    ? session.resourcesUsedAt
                    : JSON.parse(session.resourcesUsedAt || "{}");
        } catch {
            resourcesUsedAt = {};
        }

        // Add resource if not already tracked
        const resourceEntry = {
            id: String(resourceId),
            title: resourceTitle || null,
            firstOpenedAt: new Date().toISOString(),
        };

        const existingIndex = resourcesUsed.findIndex(
            (r) => r.id === String(resourceId) || r === String(resourceId)
        );

        if (existingIndex === -1) {
            resourcesUsed.push(resourceEntry);
            resourcesUsedAt[String(resourceId)] = new Date().toISOString();
        }

        const updated = await prisma.session.update({
            where: { id: sessionId },
            data: {
                resourcesUsed,
                resourcesUsedAt,
            },
            select: {
                id: true,
                resourcesUsed: true,
                resourcesUsedAt: true,
            },
        });

        return res.json({ ok: true, session: updated });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/resources-used failed");
        return res.status(500).json({ error: "Failed to track resource" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/resources-used - Get resources used in session
// --------------------------------------------------------------------------
router.get("/sessions/:id/resources-used", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                teacherId: true,
                userId: true,
                resourcesUsed: true,
                resourcesUsedAt: true,
                participants: { select: { userId: true } },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check permissions
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        let resourcesUsed = [];
        try {
            resourcesUsed = Array.isArray(session.resourcesUsed)
                ? session.resourcesUsed
                : JSON.parse(session.resourcesUsed || "[]");
        } catch {
            resourcesUsed = [];
        }

        return res.json({ resources: resourcesUsed });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/resources-used failed");
        return res.status(500).json({ error: "Failed to load resources" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/learner-feedback - Submit learner feedback/rating
// --------------------------------------------------------------------------
router.post("/sessions/:id/learner-feedback", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            select: {
                id: true,
                status: true,
                startAt: true,
                userId: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check if user is a participant
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId && p.status !== "canceled"
        );
        const isLegacyLearner = session.userId === viewerId;

        if (!(isParticipant || isLegacyLearner)) {
            return res
                .status(403)
                .json({ error: "Only session participants can submit feedback" });
        }

        // Only allow feedback after session has started
        const now = new Date();
        if (new Date(session.startAt) > now) {
            return res
                .status(400)
                .json({ error: "Cannot submit feedback before session starts" });
        }

        const { rating, highlights, improvements, otherFeedback } = req.body || {};

        // Validate rating
        const ratingNum = Number(rating);
        if (!rating || Number.isNaN(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ error: "Rating must be between 1 and 5" });
        }

        // Upsert feedback (update if exists, create if not)
        const feedback = await prisma.learnerSessionFeedback.upsert({
            where: {
                sessionId_learnerId: {
                    sessionId,
                    learnerId: viewerId,
                },
            },
            update: {
                rating: ratingNum,
                highlights:
                    typeof highlights === "string" ? highlights.slice(0, 2000) : null,
                improvements:
                    typeof improvements === "string" ? improvements.slice(0, 2000) : null,
                otherFeedback:
                    typeof otherFeedback === "string"
                        ? otherFeedback.slice(0, 2000)
                        : null,
            },
            create: {
                sessionId,
                learnerId: viewerId,
                rating: ratingNum,
                highlights:
                    typeof highlights === "string" ? highlights.slice(0, 2000) : null,
                improvements:
                    typeof improvements === "string" ? improvements.slice(0, 2000) : null,
                otherFeedback:
                    typeof otherFeedback === "string"
                        ? otherFeedback.slice(0, 2000)
                        : null,
            },
        });

        // Also update the feedbackScore on the session (average of all ratings)
        const allFeedbacks = await prisma.learnerSessionFeedback.findMany({
            where: { sessionId },
            select: { rating: true },
        });

        if (allFeedbacks.length > 0) {
            const avgRating = Math.round(
                allFeedbacks.reduce((sum, f) => sum + f.rating, 0) / allFeedbacks.length
            );

            await prisma.session.update({
                where: { id: sessionId },
                data: { feedbackScore: avgRating },
            });
        }

        return res.json({ ok: true, feedback });
    } catch (err) {
        logger.error({ err }, "POST /sessions/:id/learner-feedback failed");
        return res.status(500).json({ error: "Failed to submit feedback" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/learner-feedback - Get learner's own feedback
// --------------------------------------------------------------------------
router.get("/sessions/:id/learner-feedback", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const viewerId = req.viewUserId;

        const feedback = await prisma.learnerSessionFeedback.findUnique({
            where: {
                sessionId_learnerId: {
                    sessionId,
                    learnerId: viewerId,
                },
            },
        });

        return res.json({ feedback: feedback || null });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/learner-feedback failed");
        return res.status(500).json({ error: "Failed to load feedback" });
    }
});

// --------------------------------------------------------------------------
// GET /api/sessions/:id/all-learner-feedback - Get all feedback (teacher/admin only)
// --------------------------------------------------------------------------
router.get(
    "/sessions/:id/all-learner-feedback",
    requireAuth,
    async (req, res) => {
        try {
            const sessionId = Number(req.params.id);
            if (!sessionId || Number.isNaN(sessionId)) {
                return res.status(400).json({ error: "Invalid session id" });
            }

            const session = await prisma.session.findUnique({
                where: { id: sessionId },
                select: {
                    id: true,
                    teacherId: true,
                },
            });

            if (!session) {
                return res.status(404).json({ error: "Session not found" });
            }

            // Only teacher or admin can see all feedback
            const isTeacher = session.teacherId === req.user.id;
            const isAdmin = req.user.role === "admin";

            if (!(isTeacher || isAdmin)) {
                return res.status(403).json({ error: "Forbidden" });
            }

            const feedbacks = await prisma.learnerSessionFeedback.findMany({
                where: { sessionId },
                include: {
                    learner: {
                        select: { id: true, name: true, email: true },
                    },
                },
                orderBy: { createdAt: "desc" },
            });

            return res.json({ feedbacks });
        } catch (err) {
            logger.error({ err }, "GET /sessions/:id/all-learner-feedback failed");
            return res.status(500).json({ error: "Failed to load feedback" });
        }
    }
);

// --------------------------------------------------------------------------
// GET /api/sessions/:id/summary - Get complete session summary
// --------------------------------------------------------------------------
router.get("/sessions/:id/summary", requireAuth, async (req, res) => {
    try {
        const sessionId = Number(req.params.id);
        if (!sessionId || Number.isNaN(sessionId)) {
            return res.status(400).json({ error: "Invalid session id" });
        }

        const session = await prisma.session.findUnique({
            where: { id: sessionId },
            include: {
                teacher: { select: { id: true, name: true, email: true } },
                user: { select: { id: true, name: true, email: true } },
                participants: {
                    select: {
                        userId: true,
                        status: true,
                        attendedAt: true,
                        user: { select: { id: true, name: true, email: true } },
                    },
                },
                feedback: true,
                learnerFeedbacks: {
                    include: {
                        learner: { select: { id: true, name: true } },
                    },
                },
            },
        });

        if (!session) {
            return res.status(404).json({ error: "Session not found" });
        }

        // Check permissions
        const viewerId = req.viewUserId;
        const isParticipant = session.participants.some(
            (p) => p.userId === viewerId
        );
        const isLearner = isParticipant || session.userId === viewerId;
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isLearner || isTeacher || isAdmin)) {
            return res.status(403).json({ error: "Forbidden" });
        }

        // Parse resources used
        let resourcesUsed = [];
        try {
            resourcesUsed = Array.isArray(session.resourcesUsed)
                ? session.resourcesUsed
                : JSON.parse(session.resourcesUsed || "[]");
        } catch {
            resourcesUsed = [];
        }

        // Build attendance summary
        const attendanceSummary = {
            total: session.participants.length,
            attended: session.participants.filter((p) => p.status === "attended")
                .length,
            noShow: session.participants.filter((p) => p.status === "no_show").length,
            excused: session.participants.filter((p) => p.status === "excused")
                .length,
            canceled: session.participants.filter((p) => p.status === "canceled")
                .length,
        };

        // Build feedback summary (only for teacher/admin)
        let feedbackSummary = null;
        if (isTeacher || isAdmin) {
            const ratings = session.learnerFeedbacks.map((f) => f.rating);
            feedbackSummary = {
                count: ratings.length,
                averageRating:
                    ratings.length > 0
                        ? Math.round(
                            (ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10
                        ) / 10
                        : null,
                feedbacks: session.learnerFeedbacks,
            };
        } else {
            // Learners only see their own feedback
            const ownFeedback = session.learnerFeedbacks.find(
                (f) => f.learnerId === viewerId
            );
            feedbackSummary = {
                myFeedback: ownFeedback || null,
            };
        }

        const summary = {
            session: {
                id: session.id,
                title: session.title,
                type: session.type,
                status: session.status,
                startAt: session.startAt,
                endAt: session.endAt,
                teacher: session.teacher,
            },
            attendance: attendanceSummary,
            participants: session.participants.map((p) => ({
                ...p.user,
                status: p.status,
                attendedAt: p.attendedAt,
            })),
            teacherNotes: isTeacher || isAdmin ? session.teacherNotes : null,
            resourcesUsed,
            teacherFeedback: session.feedback
                ? {
                    messageToLearner: session.feedback.messageToLearner,
                    commentsOnSession: session.feedback.commentsOnSession,
                    futureSteps: session.feedback.futureSteps,
                }
                : null,
            learnerFeedback: feedbackSummary,
        };

        return res.json({ summary });
    } catch (err) {
        logger.error({ err }, "GET /sessions/:id/summary failed");
        return res.status(500).json({ error: "Failed to load summary" });
    }
});

export default router;
