// Lesson recap progress: which steps of a finished lesson (read the report,
// practise it, do the homework) each learner has completed.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { computeLessonSteps, countPracticeItems } from "../lib/lessonSteps.js";

const router = Router();

const SessionParams = z.object({ id: z.coerce.number().int().positive() });
const StepBody = z.object({ step: z.enum(["reviewed", "practised"]) }).strict();
const STEP_FIELD = { reviewed: "reviewedAt", practised: "practisedAt" };
const CONTINUE_WINDOW_DAYS = 60;

const isAdmin = (req) => req.user?.role === "admin";
const isImpersonating = (req) => Boolean(req.session?.asUserId);

function activeLearnerIds(session) {
  const active = (session.participants || [])
    .filter((p) => p.status !== "canceled")
    .map((p) => p.userId);
  const ids = session.userId ? [session.userId, ...active] : active;
  return [...new Set(ids)];
}

function feedbackComments(session) {
  return session.feedback?.commentsOnSession || session.teacherFeedbackComments || "";
}

function hasFeedback(session) {
  return Boolean(
    session.feedback ||
      session.teacherFeedbackMessageToLearner ||
      session.teacherFeedbackComments ||
      session.teacherFeedbackFutureSteps
  );
}

const sessionSelect = {
  id: true,
  type: true,
  status: true,
  userId: true,
  teacherId: true,
  participants: { select: { userId: true, status: true, user: { select: { id: true, name: true, email: true } } } },
  user: { select: { id: true, name: true, email: true } },
  feedback: { select: { commentsOnSession: true } },
  teacherFeedbackMessageToLearner: true,
  teacherFeedbackComments: true,
  teacherFeedbackFutureSteps: true,
};

function toProgress(row) {
  return { reviewedAt: row?.reviewedAt || null, practisedAt: row?.practisedAt || null };
}

async function loadLesson(req, res) {
  const session = await prisma.session.findUnique({ where: { id: req.params.id }, select: sessionSelect });
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  const learnerIds = activeLearnerIds(session);
  const teaching = isAdmin(req) || session.teacherId === req.user.id;
  const learning = learnerIds.includes(req.viewUserId);
  if (!teaching && !learning) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  return { session, learnerIds, teaching, learning };
}

// --------------------------------------------------------------------------
// GET /api/sessions/:id/lesson-progress
// Learners get their own steps; the teacher gets every learner's.
// --------------------------------------------------------------------------
router.get(
  "/sessions/:id/lesson-progress",
  requireAuth,
  validateRequest({ params: SessionParams }),
  async (req, res) => {
    try {
      const lesson = await loadLesson(req, res);
      if (!lesson) return;
      const { session, learnerIds, teaching, learning } = lesson;
      const forIds = learning && !teaching ? [req.viewUserId] : learnerIds;

      const [rows, homework] = await Promise.all([
        prisma.lessonProgress.findMany({ where: { sessionId: session.id, learnerId: { in: forIds } } }),
        prisma.homeworkAssignment.findMany({
          where: { sessionId: session.id, learnerId: { in: forIds } },
          select: { learnerId: true, status: true },
        }),
      ]);
      const practiceItems = countPracticeItems(feedbackComments(session));
      const feedbackPublished = hasFeedback(session);
      const forLearner = (learnerId) => {
        const progress = rows.find((r) => r.learnerId === learnerId) || null;
        return {
          ...toProgress(progress),
          steps: computeLessonSteps({
            hasFeedback: feedbackPublished,
            practiceItems,
            progress,
            homework: homework.filter((a) => a.learnerId === learnerId),
          }),
        };
      };

      if (learning && !teaching) {
        return res.json({ practiceItems, progress: forLearner(req.viewUserId) });
      }

      const people = new Map();
      if (session.user) people.set(session.user.id, session.user);
      for (const p of session.participants) if (p.user) people.set(p.user.id, p.user);
      res.json({
        practiceItems,
        learners: learnerIds.map((id) => ({
          id,
          name: people.get(id)?.name || people.get(id)?.email || "Learner",
          ...forLearner(id),
        })),
      });
    } catch (e) {
      logger.error({ err: e }, "GET /sessions/:id/lesson-progress error");
      res.status(500).json({ error: "Failed to load lesson progress" });
    }
  }
);

// --------------------------------------------------------------------------
// POST /api/sessions/:id/lesson-progress  { step: "reviewed" | "practised" }
// Records the first time the learner finished a step; later calls keep it.
// --------------------------------------------------------------------------
router.post(
  "/sessions/:id/lesson-progress",
  requireAuth,
  validateRequest({ params: SessionParams, body: StepBody }),
  async (req, res) => {
    try {
      const lesson = await loadLesson(req, res);
      if (!lesson) return;
      if (!lesson.learning) return res.status(403).json({ error: "Only the lesson's learners record progress" });
      if (!hasFeedback(lesson.session)) {
        return res.status(409).json({ error: "Your teacher hasn't shared feedback for this lesson yet" });
      }

      const key = { sessionId_learnerId: { sessionId: lesson.session.id, learnerId: req.viewUserId } };
      const existing = await prisma.lessonProgress.findUnique({ where: key });
      const field = STEP_FIELD[req.body.step];

      // Someone viewing as the learner (an admin) must not tick their steps.
      if (isImpersonating(req) || existing?.[field]) {
        return res.json({ progress: toProgress(existing), recorded: false });
      }

      const now = new Date();
      const row = await prisma.lessonProgress.upsert({
        where: key,
        create: { sessionId: lesson.session.id, learnerId: req.viewUserId, [field]: now },
        update: { [field]: now },
      });
      res.json({ progress: toProgress(row), recorded: true });
    } catch (e) {
      logger.error({ err: e }, "POST /sessions/:id/lesson-progress error");
      res.status(500).json({ error: "Failed to save lesson progress" });
    }
  }
);

// --------------------------------------------------------------------------
// GET /api/me/lessons/continue
// The most recent finished lesson that still has a step to do, for the
// learner dashboard's "Continue your lesson" card.
// --------------------------------------------------------------------------
router.get("/me/lessons/continue", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const since = new Date(Date.now() - CONTINUE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const sessions = await prisma.session.findMany({
      where: {
        status: "completed",
        type: { not: "TRAINING" },
        startAt: { gte: since },
        OR: [{ userId }, { participants: { some: { userId, status: { not: "canceled" } } } }],
      },
      orderBy: { startAt: "desc" },
      take: 10,
      select: {
        id: true,
        title: true,
        startAt: true,
        teacher: { select: { name: true } },
        feedback: { select: { commentsOnSession: true } },
        teacherFeedbackMessageToLearner: true,
        teacherFeedbackComments: true,
        teacherFeedbackFutureSteps: true,
      },
    });
    if (!sessions.length) return res.json({ lesson: null });

    const ids = sessions.map((s) => s.id);
    const [rows, homework] = await Promise.all([
      prisma.lessonProgress.findMany({ where: { learnerId: userId, sessionId: { in: ids } } }),
      prisma.homeworkAssignment.findMany({
        where: { learnerId: userId, sessionId: { in: ids } },
        select: { sessionId: true, status: true },
      }),
    ]);

    for (const session of sessions) {
      const sessionHomework = homework.filter((a) => a.sessionId === session.id);
      const feedbackPublished = hasFeedback(session);
      if (!feedbackPublished && !sessionHomework.length) continue;
      const steps = computeLessonSteps({
        hasFeedback: feedbackPublished,
        practiceItems: countPracticeItems(feedbackComments(session)),
        progress: rows.find((r) => r.sessionId === session.id) || null,
        homework: sessionHomework,
      });
      if (steps.done) continue;
      return res.json({
        lesson: {
          id: session.id,
          title: session.title,
          startAt: session.startAt,
          teacherName: session.teacher?.name || null,
          steps,
        },
      });
    }
    res.json({ lesson: null });
  } catch (e) {
    logger.error({ err: e }, "GET /me/lessons/continue error");
    res.status(500).json({ error: "Failed to load your lessons" });
  }
});

export default router;
