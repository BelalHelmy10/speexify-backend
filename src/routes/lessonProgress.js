// Lesson recap progress: which steps of a finished lesson (read the report,
// practise it, do the homework) each learner has completed.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { computeLessonSteps, countPracticeItems, parseReportItems } from "../lib/lessonSteps.js";
import { normalizeReviewResources } from "../services/sessionReviewService.js";

const router = Router();

const SessionParams = z.object({ id: z.coerce.number().int().positive() });
const StepBody = z.object({ step: z.enum(["reviewed", "practised"]) }).strict();
const STEP_FIELD = { reviewed: "reviewedAt", practised: "practisedAt" };
const CONTINUE_WINDOW_DAYS = 60;
const HISTORY_LIMIT = 300;
const LearnerParams = z.object({ learnerId: z.coerce.number().int().positive() });

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
  resourcesUsed: true,
  resourcesUsedAt: true,
};

// Curriculum materials opened in class, in the order they were opened.
// Uploads made in the classroom are left out.
function lessonMaterials(session) {
  return normalizeReviewResources(session.resourcesUsed, session.resourcesUsedAt || {})
    .filter((m) => !m.snapshot?.classroomUpload)
    .map((m) => ({ id: m.id, firstOpenedAt: m.firstOpenedAt }));
}

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
        return res.json({ practiceItems, materials: lessonMaterials(session), progress: forLearner(req.viewUserId) });
      }

      const people = new Map();
      if (session.user) people.set(session.user.id, session.user);
      for (const p of session.participants) if (p.user) people.set(p.user.id, p.user);
      res.json({
        practiceItems,
        materials: lessonMaterials(session),
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

// --------------------------------------------------------------------------
// Lesson history: every finished lesson with the class materials opened in
// it, its report rows, homework and steps. The site groups these into the
// curriculum units the materials belong to.
// --------------------------------------------------------------------------
const learnerOf = (learnerId) => ({
  OR: [{ userId: learnerId }, { participants: { some: { userId: learnerId, status: { not: "canceled" } } } }],
});

async function lessonHistory(learnerId, extraWhere = {}) {
  const sessions = await prisma.session.findMany({
    where: { status: "completed", type: { not: "TRAINING" }, ...learnerOf(learnerId), ...extraWhere },
    orderBy: { startAt: "desc" },
    take: HISTORY_LIMIT,
    select: {
      id: true,
      title: true,
      startAt: true,
      resourcesUsed: true,
      resourcesUsedAt: true,
      teacher: { select: { name: true } },
      feedback: { select: { commentsOnSession: true, futureSteps: true } },
      teacherFeedbackMessageToLearner: true,
      teacherFeedbackComments: true,
      teacherFeedbackFutureSteps: true,
    },
  });
  if (!sessions.length) return [];

  const ids = sessions.map((s) => s.id);
  const [rows, homework] = await Promise.all([
    prisma.lessonProgress.findMany({ where: { learnerId, sessionId: { in: ids } } }),
    prisma.homeworkAssignment.findMany({
      where: { learnerId, sessionId: { in: ids } },
      select: { id: true, sessionId: true, title: true, status: true, dueAt: true, completedTasks: true, taskCount: true },
    }),
  ]);

  return sessions.map((session) => {
    const comments = feedbackComments(session);
    const sessionHomework = homework.filter((a) => a.sessionId === session.id);
    const feedbackPublished = hasFeedback(session);
    return {
      id: session.id,
      title: session.title,
      startAt: session.startAt,
      teacherName: session.teacher?.name || null,
      hasFeedback: feedbackPublished,
      materials: lessonMaterials(session),
      items: parseReportItems(comments),
      futureSteps: (session.feedback?.futureSteps || session.teacherFeedbackFutureSteps || "").trim() || null,
      homework: sessionHomework.map(({ sessionId, ...a }) => a),
      steps: computeLessonSteps({
        hasFeedback: feedbackPublished,
        practiceItems: countPracticeItems(comments),
        progress: rows.find((r) => r.sessionId === session.id) || null,
        homework: sessionHomework,
      }),
    };
  });
}

// GET /api/me/lesson-history — the signed-in learner's own lessons.
router.get("/me/lesson-history", requireAuth, async (req, res) => {
  try {
    res.json({ lessons: await lessonHistory(req.viewUserId) });
  } catch (e) {
    logger.error({ err: e }, "GET /me/lesson-history error");
    res.status(500).json({ error: "Failed to load your lessons" });
  }
});

// GET /api/learners/:learnerId/lesson-history — for the learner's teacher
// (only the lessons they taught) or an admin (every lesson).
router.get(
  "/learners/:learnerId/lesson-history",
  requireAuth,
  validateRequest({ params: LearnerParams }),
  async (req, res) => {
    try {
      const learnerId = req.params.learnerId;
      const admin = isAdmin(req);
      if (!admin && req.user?.role !== "teacher") return res.status(403).json({ error: "Forbidden" });

      const lessons = await lessonHistory(learnerId, admin ? {} : { teacherId: req.user.id });
      if (!admin && !lessons.length) return res.status(403).json({ error: "Forbidden" });

      const learner = await prisma.user.findUnique({ where: { id: learnerId }, select: { id: true, name: true, email: true } });
      if (!learner) return res.status(404).json({ error: "Learner not found" });
      res.json({ learner: { id: learner.id, name: learner.name || learner.email || "Learner" }, lessons });
    } catch (e) {
      logger.error({ err: e }, "GET /learners/:learnerId/lesson-history error");
      res.status(500).json({ error: "Failed to load the learner's lessons" });
    }
  }
);

export default router;
