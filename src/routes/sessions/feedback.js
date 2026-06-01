// src/routes/sessions/feedback.js
// Teacher feedback endpoints

import {
    Router,
    prisma,
    requireAuth,
    sendFeedbackNotifications,
    logger,
} from "./_shared.js";
import { z } from "zod";
import { validateRequest } from "../../middleware/validateRequest.js";

const router = Router();

const SessionIdParamsSchema = z.object({
    id: z.coerce.number().int().positive(),
});

const FeedbackTextSchema = z.preprocess(
    (value) => (value == null ? "" : value),
    z.string().trim().max(5000)
);

const FeedbackBodySchema = z
    .object({
        messageToLearner: FeedbackTextSchema.default(""),
        commentsOnSession: FeedbackTextSchema.default(""),
        futureSteps: FeedbackTextSchema.default(""),
    })
    .strict();

// --------------------------------------------------------------------------
// GET /api/sessions/:id/feedback - Get detailed teacher feedback
// FIX: Use correct relation name and handle both sources
// --------------------------------------------------------------------------
router.get("/sessions/:id/feedback", requireAuth, async (req, res) => {
    try {
        const id = Number(req.params.id);
        const session = await prisma.session.findUnique({
            where: { id },
            select: {
                id: true,
                userId: true,
                teacherId: true,
                participants: { select: { userId: true } },
                feedback: true, // FIX: Correct relation name
                // Also get legacy fields as fallback
                teacherFeedbackMessageToLearner: true,
                teacherFeedbackComments: true,
                teacherFeedbackFutureSteps: true,
            },
        });

        if (!session) return res.status(404).json({ error: "Session not found" });

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

        // Return feedback from relation or legacy fields
        if (session.feedback) {
            return res.json(session.feedback);
        }

        // Fallback to legacy fields
        const hasLegacy =
            session.teacherFeedbackMessageToLearner ||
            session.teacherFeedbackComments ||
            session.teacherFeedbackFutureSteps;

        if (hasLegacy) {
            return res.json({
                messageToLearner: session.teacherFeedbackMessageToLearner || "",
                commentsOnSession: session.teacherFeedbackComments || "",
                futureSteps: session.teacherFeedbackFutureSteps || "",
            });
        }

        res.json(null);
    } catch (e) {
        logger.error({ err: e }, "GET /sessions/:id/feedback error");
        res.status(500).json({ error: "Failed to load feedback" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/feedback - Create/update detailed teacher feedback
// --------------------------------------------------------------------------
router.post(
    "/sessions/:id/feedback",
    requireAuth,
    validateRequest({ params: SessionIdParamsSchema, body: FeedbackBodySchema }),
    async (req, res) => {
    try {
        const id = Number(req.params.id);
        const session = await prisma.session.findUnique({
            where: { id },
            select: {
                id: true,
                title: true,
                userId: true,
                teacherId: true,
                startAt: true,
                type: true,
                participants: { select: { userId: true, status: true } },
            },
        });

        if (!session) return res.status(404).json({ error: "Session not found" });

        // Only the teacher assigned to this session (or admin) can write feedback
        const isTeacher = session.teacherId === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!(isTeacher || isAdmin)) {
            return res
                .status(403)
                .json({ error: "Only the teacher can give feedback" });
        }

        // Only allow after the session has started
        const now = new Date();
        if (new Date(session.startAt) > now) {
            return res
                .status(400)
                .json({ error: "You can only leave feedback after the session" });
        }

        const { messageToLearner, commentsOnSession, futureSteps } = req.body;

        // Check if feedback already exists (to know if this is new or update)
        const existingFeedback = await prisma.sessionFeedback.findUnique({
            where: { sessionId: session.id },
        });

        const isNewFeedback = !existingFeedback;

        const feedback = await prisma.sessionFeedback.upsert({
            where: { sessionId: session.id },
            update: {
                messageToLearner,
                commentsOnSession,
                futureSteps,
            },
            create: {
                sessionId: session.id,
                teacherId: req.user.id,
                messageToLearner,
                commentsOnSession,
                futureSteps,
            },
        });

        // ✅ Send notification + email only for NEW feedback (not updates)
        if (isNewFeedback) {
            try {
                // Get learner IDs
                const learnerIds = [];
                if (session.type === "GROUP") {
                    const activeParticipants = (session.participants || [])
                        .filter((p) => p.status !== "canceled")
                        .map((p) => p.userId);
                    learnerIds.push(...activeParticipants);
                } else {
                    // ONE_ON_ONE - check legacy userId or participants
                    if (session.userId) {
                        learnerIds.push(session.userId);
                    } else if (session.participants?.length) {
                        const active = session.participants
                            .filter((p) => p.status !== "canceled")
                            .map((p) => p.userId);
                        learnerIds.push(...active);
                    }
                }

                if (learnerIds.length > 0) {
                    await sendFeedbackNotifications({
                        session,
                        learnerIds,
                        teacherId: req.user.id,
                        feedback: {
                            messageToLearner,
                            commentsOnSession,
                            futureSteps,
                        },
                    });
                }
            } catch (e) {
                logger.error(
                    { err: e, sessionId: session.id },
                    "feedback notifications failed"
                );
                // Don't fail the request if notifications fail
            }
        }

        res.json({ ok: true, feedback });
    } catch (e) {
        logger.error({ err: e }, "POST /sessions/:id/feedback error");
        res.status(500).json({ error: "Failed to save feedback" });
    }
});

// --------------------------------------------------------------------------
// POST /api/sessions/:id/feedback/teacher - Legacy feedback endpoint
// --------------------------------------------------------------------------
router.post(
    "/sessions/:id/feedback/teacher",
    requireAuth,
    validateRequest({ params: SessionIdParamsSchema, body: FeedbackBodySchema }),
    async (req, res, next) => {
        try {
            const id = Number(req.params.id);

            const { messageToLearner, commentsOnSession, futureSteps } =
                req.body || {};

            const session = await prisma.session.findUnique({
                where: { id },
            });

            if (!session) {
                return res.status(404).json({ error: "Session not found" });
            }

            // Only the assigned teacher can edit feedback
            if (
                req.user.role !== "teacher" ||
                !session.teacherId ||
                session.teacherId !== req.user.id
            ) {
                return res
                    .status(403)
                    .json({ error: "Only the assigned teacher can update feedback" });
            }

            const updated = await prisma.session.update({
                where: { id },
                data: {
                    teacherFeedbackMessageToLearner: messageToLearner || null,
                    teacherFeedbackComments: commentsOnSession || null,
                    teacherFeedbackFutureSteps: futureSteps || null,
                },
            });

            return res.json({ session: updated });
        } catch (err) {
            logger.error({ err }, "Teacher feedback save failed");
            return next(err);
        }
    }
);

export default router;
