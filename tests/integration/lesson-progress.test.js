import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/lessonProgress.js";
import { prisma } from "../../src/lib/prisma.js";
import { computeLessonSteps, countPracticeItems } from "../../src/lib/lessonSteps.js";
import { lessonRecapUrl } from "../../src/services/emailTemplates.js";

// Users: 10 learner, 11 other learner, 20 teacher, 21 other teacher, 30 admin
const USERS = {
  10: { id: 10, role: "learner", name: "Nour", email: "nour@example.test" },
  11: { id: 11, role: "learner", name: "Ali", email: "ali@example.test" },
  20: { id: 20, role: "teacher", name: "Sara", email: "sara@example.test" },
  21: { id: 21, role: "teacher", name: "Omar", email: "omar@example.test" },
  30: { id: 30, role: "admin", name: "Admin", email: "admin@example.test" },
};

function report(items) {
  return `Structured session recap\n[[SPEEXIFY_FEEDBACK_REPORT_V1]]\n${JSON.stringify({ version: 1, items })}\n[[/SPEEXIFY_FEEDBACK_REPORT_V1]]`;
}

const REPORT = report([
  { type: "vocabulary", prompt: "convince", response: "To make someone believe something." },
  { type: "grammar", prompt: "I *am agree*.", response: "I *agree*." },
  { type: "note", prompt: "Confidence", response: "Much better today." },
]);

function makeSession(overrides = {}) {
  return {
    id: 42,
    title: "Voicing your opinion",
    type: "ONE_ON_ONE",
    status: "completed",
    startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    userId: 10,
    teacherId: 20,
    participants: [],
    user: USERS[10],
    teacher: { name: "Sara" },
    feedback: { commentsOnSession: REPORT },
    teacherFeedbackMessageToLearner: null,
    teacherFeedbackComments: null,
    teacherFeedbackFutureSteps: null,
    ...overrides,
  };
}

function setup({ sessions = [makeSession()], homework = [] } = {}) {
  const rows = new Map();
  const keyOf = (sessionId, learnerId) => `${sessionId}:${learnerId}`;
  const inList = (value, cond) => (cond && typeof cond === "object" && "in" in cond ? cond.in.includes(value) : value === cond);
  const originals = {
    userFindUnique: prisma.user.findUnique,
    sessionFindUnique: prisma.session.findUnique,
    sessionFindMany: prisma.session.findMany,
    hwFindMany: prisma.homeworkAssignment.findMany,
    lp: prisma.lessonProgress ? { ...prisma.lessonProgress } : undefined,
  };

  prisma.user.findUnique = async ({ where }) => ({ ...USERS[where.id], isDisabled: false, passwordChangedAt: null });
  prisma.session.findUnique = async ({ where }) => sessions.find((s) => s.id === where.id) || null;
  prisma.session.findMany = async () => sessions;
  prisma.homeworkAssignment.findMany = async ({ where }) =>
    homework.filter((a) => inList(a.learnerId, where.learnerId) && inList(a.sessionId, where.sessionId));
  prisma.lessonProgress = prisma.lessonProgress || {};
  prisma.lessonProgress.findMany = async ({ where }) =>
    [...rows.values()].filter((r) => inList(r.learnerId, where.learnerId) && inList(r.sessionId, where.sessionId));
  prisma.lessonProgress.findUnique = async ({ where }) =>
    rows.get(keyOf(where.sessionId_learnerId.sessionId, where.sessionId_learnerId.learnerId)) || null;
  prisma.lessonProgress.upsert = async ({ where, create, update }) => {
    const key = keyOf(where.sessionId_learnerId.sessionId, where.sessionId_learnerId.learnerId);
    const row = rows.has(key) ? { ...rows.get(key), ...update } : { reviewedAt: null, practisedAt: null, ...create };
    rows.set(key, row);
    return row;
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"]) } };
    if (req.headers["x-test-as"]) req.session.asUserId = Number(req.headers["x-test-as"]);
    next();
  });
  app.use(router);

  const restore = () => {
    prisma.user.findUnique = originals.userFindUnique;
    prisma.session.findUnique = originals.sessionFindUnique;
    prisma.session.findMany = originals.sessionFindMany;
    prisma.homeworkAssignment.findMany = originals.hwFindMany;
    if (originals.lp) Object.assign(prisma.lessonProgress, originals.lp);
  };
  const as = (userId, extra = {}) => ({ "x-test-user": String(userId), ...extra });
  return { app, rows, restore, as };
}

test("practice items count new words, mistakes and pronunciation only", () => {
  assert.equal(countPracticeItems(REPORT), 2);
  assert.equal(countPracticeItems("Plain feedback from before the report format"), 0);
  assert.equal(countPracticeItems("[[SPEEXIFY_FEEDBACK_REPORT_V1]]not json[[/SPEEXIFY_FEEDBACK_REPORT_V1]]"), 0);
});

test("lesson steps run review, practise, homework and skip what the lesson lacks", () => {
  const fresh = computeLessonSteps({ practiceItems: 2, homework: [{ status: "ASSIGNED" }] });
  assert.equal(fresh.next, "review");
  assert.equal(fresh.done, false);

  const reviewed = computeLessonSteps({ practiceItems: 2, progress: { reviewedAt: new Date() }, homework: [] });
  assert.equal(reviewed.next, "practise");
  assert.equal(reviewed.homework, null);

  const notesOnly = computeLessonSteps({ practiceItems: 0, progress: { reviewedAt: new Date() } });
  assert.equal(notesOnly.practise, null);
  assert.equal(notesOnly.done, true);

  const homeworkLeft = computeLessonSteps({
    practiceItems: 2,
    progress: { reviewedAt: new Date(), practisedAt: new Date() },
    homework: [{ status: "SUBMITTED" }, { status: "IN_PROGRESS" }],
  });
  assert.equal(homeworkLeft.next, "homework");
  assert.deepEqual(homeworkLeft.homework, { done: false, total: 2, completed: 1 });
});

test("a learner records review and practice once, and sees their steps", async () => {
  const t = setup({ homework: [{ learnerId: 10, sessionId: 42, status: "ASSIGNED" }] });
  try {
    const start = await request(t.app).get("/sessions/42/lesson-progress").set(t.as(10));
    assert.equal(start.statusCode, 200);
    assert.equal(start.body.practiceItems, 2);
    assert.equal(start.body.progress.steps.next, "review");

    const first = await request(t.app).post("/sessions/42/lesson-progress").set(t.as(10)).send({ step: "reviewed" });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.recorded, true);
    const firstAt = first.body.progress.reviewedAt;

    const again = await request(t.app).post("/sessions/42/lesson-progress").set(t.as(10)).send({ step: "reviewed" });
    assert.equal(again.body.recorded, false);
    assert.equal(again.body.progress.reviewedAt, firstAt);

    await request(t.app).post("/sessions/42/lesson-progress").set(t.as(10)).send({ step: "practised" });
    const after = await request(t.app).get("/sessions/42/lesson-progress").set(t.as(10));
    assert.equal(after.body.progress.steps.next, "homework");

    const bad = await request(t.app).post("/sessions/42/lesson-progress").set(t.as(10)).send({ step: "finished" });
    assert.equal(bad.statusCode, 400);
  } finally {
    t.restore();
  }
});

test("only the lesson's learners record steps; the teacher sees each learner", async () => {
  const group = makeSession({
    type: "GROUP",
    userId: null,
    participants: [
      { userId: 10, status: "booked", user: USERS[10] },
      { userId: 11, status: "booked", user: USERS[11] },
    ],
  });
  const t = setup({ sessions: [group] });
  try {
    assert.equal((await request(t.app).post("/sessions/42/lesson-progress").set(t.as(20)).send({ step: "reviewed" })).statusCode, 403);
    assert.equal((await request(t.app).get("/sessions/42/lesson-progress").set(t.as(21))).statusCode, 403);

    await request(t.app).post("/sessions/42/lesson-progress").set(t.as(11)).send({ step: "reviewed" });
    const teacher = await request(t.app).get("/sessions/42/lesson-progress").set(t.as(20));
    assert.equal(teacher.statusCode, 200);
    assert.deepEqual(
      teacher.body.learners.map((l) => [l.name, Boolean(l.reviewedAt), l.steps.next]),
      [["Nour", false, "review"], ["Ali", true, "practise"]]
    );
  } finally {
    t.restore();
  }
});

test("an admin viewing as the learner does not tick their steps", async () => {
  const t = setup();
  try {
    const res = await request(t.app)
      .post("/sessions/42/lesson-progress")
      .set(t.as(30, { "x-test-as": "10" }))
      .send({ step: "reviewed" });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.recorded, false);
    assert.equal(t.rows.size, 0);
  } finally {
    t.restore();
  }
});

test("steps cannot be recorded before the teacher shares feedback", async () => {
  const t = setup({ sessions: [makeSession({ feedback: null })] });
  try {
    const res = await request(t.app).post("/sessions/42/lesson-progress").set(t.as(10)).send({ step: "reviewed" });
    assert.equal(res.statusCode, 409);
  } finally {
    t.restore();
  }
});

test("continue points at the newest lesson with a step left", async () => {
  const done = makeSession({ id: 50, startAt: new Date(Date.now() - 1 * 60 * 60 * 1000), title: "Done lesson" });
  const open = makeSession({ id: 42, title: "Open lesson" });
  const t = setup({ sessions: [done, open] });
  try {
    t.rows.set("50:10", { sessionId: 50, learnerId: 10, reviewedAt: new Date(), practisedAt: new Date() });
    const res = await request(t.app).get("/me/lessons/continue").set(t.as(10));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.lesson.id, 42);
    assert.equal(res.body.lesson.steps.next, "review");
    assert.equal(res.body.lesson.teacherName, "Sara");

    t.rows.set("42:10", { sessionId: 42, learnerId: 10, reviewedAt: new Date(), practisedAt: new Date() });
    const none = await request(t.app).get("/me/lessons/continue").set(t.as(10));
    assert.equal(none.body.lesson, null);
  } finally {
    t.restore();
  }
});

test("the feedback email opens the lesson page in the learner's language", () => {
  assert.equal(lessonRecapUrl(42, "en"), "https://app.speexify.com/dashboard/sessions/42#lesson");
  assert.equal(lessonRecapUrl(42, "ar"), "https://app.speexify.com/ar/dashboard/sessions/42#lesson");
});
