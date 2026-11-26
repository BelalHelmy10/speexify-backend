// src/routes/homework.js
// Interactive homework: a teacher assigns it after a session, the learner
// completes it on the platform (autosaved), the teacher follows and reviews it.
//
//   GET    /homework/templates             teacher/admin: homework they can assign
//   GET    /sessions/:id/homework          homework for a session (+ assign defaults for teachers)
//   POST   /sessions/:id/homework          teacher/admin: assign to the session's learners
//   GET    /homework                       learner: my homework · teacher: homework I gave
//   GET    /homework/:id                   one assignment (answer keys hidden from learners)
//   PATCH  /homework/:id/answers           learner: autosave (optimistic version check)
//   POST   /homework/:id/check             learner: mark one task without submitting
//   POST   /homework/:id/submit            learner: hand it in
//   PATCH  /homework/:id/review            teacher/admin: comments, mark as reviewed
//   DELETE /homework/:id                   teacher/admin: remove an assignment

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { requireAuth } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import {
  MAX_ANSWERS_BYTES,
  buildAssignmentContent,
  contentForLearner,
  countCompletedTasks,
  getHomeworkTemplate,
  listHomeworkTemplates,
  markAll,
  markTask,
  sanitizeAnswers,
  suggestTemplateId,
} from "../services/homeworkService.js";
import {
  sendHomeworkAssignedNotifications,
  sendHomeworkReviewedNotification,
  sendHomeworkSubmittedNotification,
} from "../services/notificationsService.js";

const router = Router();

// Notification senders, kept on one object so tests can replace them.
export const homeworkNotifier = {
  assigned: sendHomeworkAssignedNotifications,
  submitted: sendHomeworkSubmittedNotification,
  reviewed: sendHomeworkReviewedNotification,
};

const OPEN_STATUSES = ["ASSIGNED", "IN_PROGRESS"];
const DAY_MS = 24 * 60 * 60 * 1000;

const SessionParams = z.object({ id: z.coerce.number().int().positive() });
const HomeworkParams = z.object({ id: z.string().trim().min(1).max(64) });

const AssignBody = z
  .object({
    templateId: z.string().trim().min(1).max(100),
    dueAt: z.union([z.string().datetime({ offset: true }), z.null()]).optional(),
    note: z.string().trim().max(1000).optional().default(""),
    learnerIds: z.array(z.number().int().positive()).max(50).optional(),
  })
  .strict();

const AnswersBody = z
  .object({
    answers: z.record(z.string(), z.unknown()),
    baseVersion: z.number().int().min(0),
  })
  .strict();

const SubmitBody = z
  .object({
    answers: z.record(z.string(), z.unknown()).optional(),
    baseVersion: z.number().int().min(0).optional(),
  })
  .strict();

const CheckBody = z
  .object({
    taskId: z.string().trim().min(1).max(20),
    answers: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const ReviewBody = z
  .object({
    comments: z.record(z.string().max(20), z.string().max(3000)).optional(),
    overall: z.string().max(3000).optional(),
    markReviewed: z.boolean().optional().default(false),
  })
  .strict();

// ─── helpers ──────────────────────────────────────────────────────────────

const isAdmin = (req) => req.user?.role === "admin";
const isImpersonating = (req) => Boolean(req.session?.asUserId);
const canTeach = (req, assignment) =>
  isAdmin(req) || (assignment.teacherId != null && assignment.teacherId === req.user.id);
const isOwner = (req, assignment) => assignment.learnerId === req.viewUserId;

function activeLearnerIds(session) {
  const active = (session.participants || [])
    .filter((p) => p.status !== "canceled")
    .map((p) => p.userId);
  const ids = session.userId ? [session.userId, ...active] : active;
  return [...new Set(ids)];
}

const summarySelect = {
  id: true,
  title: true,
  level: true,
  templateId: true,
  status: true,
  dueAt: true,
  note: true,
  completedTasks: true,
  taskCount: true,
  lastActivityAt: true,
  submittedAt: true,
  reviewedAt: true,
  createdAt: true,
  sessionId: true,
  learnerId: true,
  teacherId: true,
  autoScore: true,
  session: { select: { id: true, title: true, startAt: true } },
  learner: { select: { id: true, name: true, email: true } },
  teacher: { select: { id: true, name: true } },
};

function toSummary(a) {
  return {
    id: a.id,
    title: a.title,
    level: a.level,
    templateId: a.templateId,
    status: a.status,
    dueAt: a.dueAt,
    note: a.note || "",
    completedTasks: a.completedTasks,
    taskCount: a.taskCount,
    lastActivityAt: a.lastActivityAt,
    submittedAt: a.submittedAt,
    reviewedAt: a.reviewedAt,
    createdAt: a.createdAt,
    sessionId: a.sessionId,
    session: a.session || null,
    learner: a.learner ? { id: a.learner.id, name: a.learner.name || a.learner.email } : null,
    teacher: a.teacher ? { id: a.teacher.id, name: a.teacher.name } : null,
    autoScore: a.autoScore || null,
  };
}

/** Shape one assignment for the person asking. Learners never get answer keys. */
function toDetail(a, { asTeacher }) {
  const base = toSummary(a);
  const submitted = a.status === "SUBMITTED" || a.status === "REVIEWED";
  const marks = submitted || asTeacher ? markAll(a.content, a.answers).byTask : {};
  const fieldMarks = {};
  if (submitted || asTeacher) {
    for (const task of a.content?.tasks || []) {
      const result = markTask(task, a.answers?.[task.id]);
      if (result) fieldMarks[task.id] = result.fields;
    }
  }
  return {
    ...base,
    content: asTeacher ? a.content : contentForLearner(a.content),
    answers: a.answers || {},
    answersVersion: a.answersVersion,
    marks: { byTask: marks, fields: fieldMarks },
    // Learners see comments once the teacher marks the homework as reviewed.
    teacherComments: asTeacher || a.status === "REVIEWED" ? a.teacherComments || {} : {},
    viewer: asTeacher ? "teacher" : "learner",
  };
}

async function loadAssignment(id) {
  return prisma.homeworkAssignment.findUnique({
    where: { id },
    select: { ...summarySelect, content: true, answers: true, answersVersion: true, teacherComments: true },
  });
}

function answersTooLarge(answers) {
  return Buffer.byteLength(JSON.stringify(answers || {}), "utf8") > MAX_ANSWERS_BYTES;
}

function defaultDueAt(nextSessionStart, now = new Date()) {
  if (nextSessionStart) {
    const dayBefore = new Date(new Date(nextSessionStart).getTime() - DAY_MS);
    if (dayBefore.getTime() > now.getTime() + 12 * 60 * 60 * 1000) return dayBefore;
  }
  return new Date(now.getTime() + 3 * DAY_MS);
}

// ─── templates ────────────────────────────────────────────────────────────

router.get("/homework/templates", requireAuth, (req, res) => {
  if (!(isAdmin(req) || req.user.role === "teacher")) {
    return res.status(403).json({ error: "Only teachers can assign homework" });
  }
  res.json({ templates: listHomeworkTemplates() });
});

// ─── per session ──────────────────────────────────────────────────────────

router.get(
  "/sessions/:id/homework",
  requireAuth,
  validateRequest({ params: SessionParams }),
  async (req, res) => {
    try {
      const session = await prisma.session.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          type: true,
          status: true,
          startAt: true,
          userId: true,
          teacherId: true,
          resourcesUsed: true,
          participants: { select: { userId: true, status: true, user: { select: { id: true, name: true, email: true } } } },
          user: { select: { id: true, name: true, email: true } },
        },
      });
      if (!session) return res.status(404).json({ error: "Session not found" });

      const learnerIds = activeLearnerIds(session);
      const teaching = isAdmin(req) || session.teacherId === req.user.id;
      const learning = learnerIds.includes(req.viewUserId);
      if (!teaching && !learning) return res.status(403).json({ error: "Forbidden" });

      const assignments = await prisma.homeworkAssignment.findMany({
        where: { sessionId: session.id, ...(teaching ? {} : { learnerId: req.viewUserId }) },
        select: summarySelect,
        orderBy: { createdAt: "asc" },
      });

      if (!teaching) return res.json({ assignments: assignments.map(toSummary) });

      const people = new Map();
      if (session.user) people.set(session.user.id, session.user);
      for (const p of session.participants) if (p.status !== "canceled" && p.user) people.set(p.user.id, p.user);
      const learners = learnerIds
        .map((id) => people.get(id))
        .filter(Boolean)
        .map((u) => ({ id: u.id, name: u.name || u.email }));

      const nextSession = learnerIds.length
        ? await prisma.session.findFirst({
            where: {
              id: { not: session.id },
              status: "scheduled",
              startAt: { gt: new Date() },
              OR: [{ userId: { in: learnerIds } }, { participants: { some: { userId: { in: learnerIds } } } }],
            },
            orderBy: { startAt: "asc" },
            select: { startAt: true },
          })
        : null;

      res.json({
        assignments: assignments.map(toSummary),
        canAssign: session.type !== "TRAINING" && session.status !== "canceled" && new Date(session.startAt) <= new Date(),
        learners,
        suggestedTemplateId: suggestTemplateId(session.resourcesUsed),
        defaultDueAt: defaultDueAt(nextSession?.startAt),
        nextSessionAt: nextSession?.startAt || null,
        templates: listHomeworkTemplates(),
      });
    } catch (e) {
      logger.error({ err: e }, "GET /sessions/:id/homework error");
      res.status(500).json({ error: "Failed to load homework" });
    }
  }
);

router.post(
  "/sessions/:id/homework",
  requireAuth,
  validateRequest({ params: SessionParams, body: AssignBody }),
  async (req, res) => {
    try {
      const session = await prisma.session.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          title: true,
          type: true,
          status: true,
          startAt: true,
          userId: true,
          teacherId: true,
          participants: { select: { userId: true, status: true } },
        },
      });
      if (!session) return res.status(404).json({ error: "Session not found" });
      if (!(isAdmin(req) || session.teacherId === req.user.id)) {
        return res.status(403).json({ error: "Only this session's teacher can assign homework" });
      }
      if (session.type === "TRAINING") {
        return res.status(400).json({ error: "Homework can't be assigned to training sessions" });
      }
      if (session.status === "canceled") {
        return res.status(400).json({ error: "This session was canceled" });
      }
      if (new Date(session.startAt) > new Date()) {
        return res.status(400).json({ error: "You can assign homework once the session has started" });
      }

      const template = getHomeworkTemplate(req.body.templateId);
      if (!template) return res.status(400).json({ error: "Unknown homework" });

      const sessionLearners = activeLearnerIds(session);
      const targets = req.body.learnerIds?.length ? req.body.learnerIds : sessionLearners;
      if (!targets.length) return res.status(400).json({ error: "This session has no learners to assign to" });
      if (targets.some((id) => !sessionLearners.includes(id))) {
        return res.status(400).json({ error: "Homework can only go to learners in this session" });
      }

      const content = buildAssignmentContent(template);
      const created = [];
      let skipped = 0;
      for (const learnerId of targets) {
        try {
          const assignment = await prisma.homeworkAssignment.create({
            data: {
              sessionId: session.id,
              learnerId,
              teacherId: session.teacherId ?? req.user.id,
              templateId: template.id,
              templateVersion: template.version || 1,
              title: template.title,
              level: template.level || null,
              content,
              note: req.body.note || null,
              dueAt: req.body.dueAt ? new Date(req.body.dueAt) : null,
              taskCount: template.tasks.length,
            },
            select: summarySelect,
          });
          created.push(assignment);
        } catch (e) {
          // Same homework already assigned to this learner for this session.
          if (e?.code === "P2002") skipped += 1;
          else throw e;
        }
      }

      if (created.length) {
        try {
          await homeworkNotifier.assigned({
            assignments: created,
            teacherId: session.teacherId ?? req.user.id,
          });
        } catch (e) {
          logger.error({ err: e, sessionId: session.id }, "homework assigned notifications failed");
        }
      }

      res.status(created.length ? 201 : 200).json({ created: created.map(toSummary), skipped });
    } catch (e) {
      logger.error({ err: e }, "POST /sessions/:id/homework error");
      res.status(500).json({ error: "Failed to assign homework" });
    }
  }
);

// ─── lists ────────────────────────────────────────────────────────────────

router.get("/homework", requireAuth, async (req, res) => {
  try {
    const teacherView = !isImpersonating(req) && (req.user.role === "teacher" || isAdmin(req));
    const where = teacherView
      ? isAdmin(req) && req.query.all === "1"
        ? {}
        : { teacherId: req.user.id }
      : { learnerId: req.viewUserId };
    const assignments = await prisma.homeworkAssignment.findMany({
      where,
      select: summarySelect,
      orderBy: [{ createdAt: "desc" }],
      take: 200,
    });
    res.json({ viewer: teacherView ? "teacher" : "learner", assignments: assignments.map(toSummary) });
  } catch (e) {
    logger.error({ err: e }, "GET /homework error");
    res.status(500).json({ error: "Failed to load homework" });
  }
});

router.get("/homework/:id", requireAuth, validateRequest({ params: HomeworkParams }), async (req, res) => {
  try {
    const a = await loadAssignment(req.params.id);
    if (!a) return res.status(404).json({ error: "Homework not found" });
    const asTeacher = !isOwner(req, a) && canTeach(req, a);
    if (!isOwner(req, a) && !asTeacher) return res.status(403).json({ error: "Forbidden" });
    res.json({ homework: toDetail(a, { asTeacher }) });
  } catch (e) {
    logger.error({ err: e }, "GET /homework/:id error");
    res.status(500).json({ error: "Failed to load homework" });
  }
});

// ─── learner actions ──────────────────────────────────────────────────────

async function requireOwnerForWrite(req, res) {
  if (isImpersonating(req)) {
    res.status(403).json({ error: "Homework is read-only while you view as another user" });
    return null;
  }
  const a = await loadAssignment(req.params.id);
  if (!a) {
    res.status(404).json({ error: "Homework not found" });
    return null;
  }
  if (!isOwner(req, a)) {
    res.status(403).json({ error: "Only the learner can change their answers" });
    return null;
  }
  return a;
}

router.patch(
  "/homework/:id/answers",
  requireAuth,
  validateRequest({ params: HomeworkParams, body: AnswersBody }),
  async (req, res) => {
    try {
      const a = await requireOwnerForWrite(req, res);
      if (!a) return;
      if (!OPEN_STATUSES.includes(a.status)) {
        return res.status(409).json({ error: "This homework has been submitted and can't be changed", status: a.status });
      }
      const answers = sanitizeAnswers(a.content, req.body.answers);
      if (answersTooLarge(answers)) return res.status(413).json({ error: "Your answers are too long to save" });

      const completedTasks = countCompletedTasks(a.content, answers);
      const now = new Date();
      // Only write if nobody saved a newer version in the meantime (another tab or device).
      const result = await prisma.homeworkAssignment.updateMany({
        where: { id: a.id, answersVersion: req.body.baseVersion, status: { in: OPEN_STATUSES } },
        data: {
          answers,
          answersVersion: { increment: 1 },
          completedTasks,
          status: "IN_PROGRESS",
          lastActivityAt: now,
        },
      });
      if (result.count === 0) {
        const latest = await loadAssignment(a.id);
        return res.status(409).json({
          error: "Your homework was updated somewhere else",
          conflict: true,
          answers: latest?.answers || {},
          answersVersion: latest?.answersVersion ?? a.answersVersion,
          status: latest?.status,
        });
      }
      res.json({ ok: true, answersVersion: req.body.baseVersion + 1, completedTasks, savedAt: now });
    } catch (e) {
      logger.error({ err: e }, "PATCH /homework/:id/answers error");
      res.status(500).json({ error: "Failed to save your answers" });
    }
  }
);

router.post(
  "/homework/:id/check",
  requireAuth,
  validateRequest({ params: HomeworkParams, body: CheckBody }),
  async (req, res) => {
    try {
      const a = await loadAssignment(req.params.id);
      if (!a) return res.status(404).json({ error: "Homework not found" });
      if (!isOwner(req, a) && !canTeach(req, a)) return res.status(403).json({ error: "Forbidden" });
      const task = (a.content?.tasks || []).find((t) => t.id === req.body.taskId);
      if (!task) return res.status(400).json({ error: "Unknown task" });
      const source = req.body.answers ? sanitizeAnswers(a.content, req.body.answers) : a.answers || {};
      const result = markTask(task, source[task.id]);
      if (!result) return res.status(400).json({ error: "This task is checked by your teacher" });
      res.json({ taskId: task.id, ...result });
    } catch (e) {
      logger.error({ err: e }, "POST /homework/:id/check error");
      res.status(500).json({ error: "Failed to check answers" });
    }
  }
);

router.post(
  "/homework/:id/submit",
  requireAuth,
  validateRequest({ params: HomeworkParams, body: SubmitBody }),
  async (req, res) => {
    try {
      const a = await requireOwnerForWrite(req, res);
      if (!a) return;
      if (!OPEN_STATUSES.includes(a.status)) {
        return res.status(409).json({ error: "This homework was already submitted", status: a.status });
      }
      const answers = req.body.answers ? sanitizeAnswers(a.content, req.body.answers) : a.answers || {};
      if (answersTooLarge(answers)) return res.status(413).json({ error: "Your answers are too long to save" });
      if (req.body.answers && req.body.baseVersion !== undefined && req.body.baseVersion !== a.answersVersion) {
        return res.status(409).json({
          error: "Your homework was updated somewhere else",
          conflict: true,
          answers: a.answers || {},
          answersVersion: a.answersVersion,
          status: a.status,
        });
      }
      const now = new Date();
      const result = await prisma.homeworkAssignment.updateMany({
        where: { id: a.id, status: { in: OPEN_STATUSES } },
        data: {
          answers,
          answersVersion: { increment: 1 },
          completedTasks: countCompletedTasks(a.content, answers),
          autoScore: markAll(a.content, answers),
          status: "SUBMITTED",
          submittedAt: now,
          lastActivityAt: now,
        },
      });
      if (result.count === 0) return res.status(409).json({ error: "This homework was already submitted" });

      const updated = await loadAssignment(a.id);
      try {
        await homeworkNotifier.submitted({ assignment: updated });
      } catch (e) {
        logger.error({ err: e, homeworkId: a.id }, "homework submitted notification failed");
      }
      res.json({ homework: toDetail(updated, { asTeacher: false }) });
    } catch (e) {
      logger.error({ err: e }, "POST /homework/:id/submit error");
      res.status(500).json({ error: "Failed to submit homework" });
    }
  }
);

// ─── teacher actions ──────────────────────────────────────────────────────

router.patch(
  "/homework/:id/review",
  requireAuth,
  validateRequest({ params: HomeworkParams, body: ReviewBody }),
  async (req, res) => {
    try {
      const a = await loadAssignment(req.params.id);
      if (!a) return res.status(404).json({ error: "Homework not found" });
      if (!canTeach(req, a)) return res.status(403).json({ error: "Only the teacher can review this homework" });

      const taskIds = new Set((a.content?.tasks || []).map((t) => t.id));
      const comments = { ...(a.teacherComments || {}) };
      for (const [key, value] of Object.entries(req.body.comments || {})) {
        if (!taskIds.has(key)) continue;
        if (value.trim()) comments[key] = value.trim();
        else delete comments[key];
      }
      if (req.body.overall !== undefined) {
        if (req.body.overall.trim()) comments.overall = req.body.overall.trim();
        else delete comments.overall;
      }

      const finishing = req.body.markReviewed && a.status === "SUBMITTED";
      if (req.body.markReviewed && !["SUBMITTED", "REVIEWED"].includes(a.status)) {
        return res.status(409).json({ error: "You can mark it as reviewed once the learner submits it" });
      }

      await prisma.homeworkAssignment.update({
        where: { id: a.id },
        data: {
          teacherComments: comments,
          ...(finishing ? { status: "REVIEWED", reviewedAt: new Date() } : {}),
        },
      });
      const updated = await loadAssignment(a.id);
      if (finishing) {
        try {
          await homeworkNotifier.reviewed({ assignment: updated, overall: comments.overall || "" });
        } catch (e) {
          logger.error({ err: e, homeworkId: a.id }, "homework reviewed notification failed");
        }
      }
      res.json({ homework: toDetail(updated, { asTeacher: true }) });
    } catch (e) {
      logger.error({ err: e }, "PATCH /homework/:id/review error");
      res.status(500).json({ error: "Failed to save review" });
    }
  }
);

router.delete("/homework/:id", requireAuth, validateRequest({ params: HomeworkParams }), async (req, res) => {
  try {
    const a = await loadAssignment(req.params.id);
    if (!a) return res.status(404).json({ error: "Homework not found" });
    if (!canTeach(req, a)) return res.status(403).json({ error: "Only the teacher can remove this homework" });
    if (!isAdmin(req) && !OPEN_STATUSES.includes(a.status)) {
      return res.status(409).json({ error: "Submitted homework can't be removed" });
    }
    await prisma.homeworkAssignment.delete({ where: { id: a.id } });
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "DELETE /homework/:id error");
    res.status(500).json({ error: "Failed to remove homework" });
  }
});

export { defaultDueAt };
export default router;
