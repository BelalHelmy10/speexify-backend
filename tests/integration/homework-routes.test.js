import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router, { homeworkNotifier } from "../../src/routes/homework.js";
import { prisma } from "../../src/lib/prisma.js";

// Users: 10 learner, 11 other learner, 20 teacher, 21 other teacher, 30 admin
const USERS = {
  10: { id: 10, role: "learner", name: "Nour", email: "nour@example.test" },
  11: { id: 11, role: "learner", name: "Ali", email: "ali@example.test" },
  20: { id: 20, role: "teacher", name: "Sara", email: "sara@example.test" },
  21: { id: 21, role: "teacher", name: "Omar", email: "omar@example.test" },
  30: { id: 30, role: "admin", name: "Admin", email: "admin@example.test" },
};

function makeSession(overrides = {}) {
  return {
    id: 42,
    title: "Trial session",
    type: "ONE_ON_ONE",
    status: "completed",
    startAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    userId: 10,
    teacherId: 20,
    resourcesUsed: [{ id: "resource-speexify-trial-b1-first-impressions-lesson" }],
    participants: [],
    user: USERS[10],
    ...overrides,
  };
}

function setup({ session = makeSession() } = {}) {
  const rows = new Map();
  let seq = 0;
  const sent = { assigned: [], submitted: [], reviewed: [] };
  const withRelations = (row) =>
    row && {
      ...row,
      session: row.sessionId ? { id: row.sessionId, title: session.title, startAt: session.startAt } : null,
      learner: USERS[row.learnerId],
      teacher: row.teacherId ? USERS[row.teacherId] : null,
    };
  const matches = (row, where = {}) =>
    Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === "object" && "in" in cond) return cond.in.includes(row[key]);
      return row[key] === cond;
    });

  const originals = {
    userFindUnique: prisma.user.findUnique,
    sessionFindUnique: prisma.session.findUnique,
    sessionFindFirst: prisma.session.findFirst,
    hw: { ...prisma.homeworkAssignment },
    notifier: { ...homeworkNotifier },
  };

  prisma.user.findUnique = async ({ where }) => ({ ...USERS[where.id], isDisabled: false, passwordChangedAt: null });
  prisma.session.findUnique = async () => session;
  prisma.session.findFirst = async () => ({ startAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000) });
  prisma.homeworkAssignment.create = async ({ data }) => {
    for (const r of rows.values()) {
      if (r.sessionId === data.sessionId && r.learnerId === data.learnerId && r.templateId === data.templateId) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
    }
    const row = {
      id: `hw${++seq}`,
      status: "ASSIGNED",
      answers: {},
      answersVersion: 0,
      completedTasks: 0,
      teacherComments: {},
      autoScore: null,
      lastActivityAt: null,
      submittedAt: null,
      reviewedAt: null,
      createdAt: new Date(),
      ...data,
    };
    rows.set(row.id, row);
    return withRelations(row);
  };
  prisma.homeworkAssignment.findUnique = async ({ where }) => withRelations(rows.get(where.id) || null);
  prisma.homeworkAssignment.findMany = async ({ where }) => [...rows.values()].filter((r) => matches(r, where)).map(withRelations);
  prisma.homeworkAssignment.updateMany = async ({ where, data }) => {
    const row = rows.get(where.id);
    if (!row || !matches(row, where)) return { count: 0 };
    const next = { ...row, ...data };
    if (data.answersVersion?.increment) next.answersVersion = row.answersVersion + data.answersVersion.increment;
    rows.set(row.id, next);
    return { count: 1 };
  };
  prisma.homeworkAssignment.update = async ({ where, data }) => {
    rows.set(where.id, { ...rows.get(where.id), ...data });
    return withRelations(rows.get(where.id));
  };
  prisma.homeworkAssignment.delete = async ({ where }) => rows.delete(where.id);
  homeworkNotifier.assigned = async (args) => sent.assigned.push(args);
  homeworkNotifier.submitted = async (args) => sent.submitted.push(args);
  homeworkNotifier.reviewed = async (args) => sent.reviewed.push(args);

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
    prisma.session.findFirst = originals.sessionFindFirst;
    Object.assign(prisma.homeworkAssignment, originals.hw);
    Object.assign(homeworkNotifier, originals.notifier);
  };
  const as = (userId, extra = {}) => ({ "x-test-user": String(userId), ...extra });
  return { app, rows, sent, restore, as };
}

test("teacher sees assign defaults: suggested homework, learners and a due date", async () => {
  const t = setup();
  try {
    const res = await request(t.app).get("/sessions/42/homework").set(t.as(20));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canAssign, true);
    assert.equal(res.body.suggestedTemplateId, "first-impressions-b1");
    assert.deepEqual(res.body.learners, [{ id: 10, name: "Nour" }]);
    assert.ok(new Date(res.body.defaultDueAt) > new Date());
    assert.equal(res.body.templates.length, 5);

    const outsider = await request(t.app).get("/sessions/42/homework").set(t.as(21));
    assert.equal(outsider.statusCode, 403);
  } finally {
    t.restore();
  }
});

test("only the session's teacher can assign; duplicates are skipped; learner is notified", async () => {
  const t = setup();
  try {
    const body = { templateId: "first-impressions-b1", note: "Focus on task 4" };
    assert.equal((await request(t.app).post("/sessions/42/homework").set(t.as(21)).send(body)).statusCode, 403);
    assert.equal((await request(t.app).post("/sessions/42/homework").set(t.as(10)).send(body)).statusCode, 403);

    const first = await request(t.app).post("/sessions/42/homework").set(t.as(20)).send(body);
    assert.equal(first.statusCode, 201);
    assert.equal(first.body.created.length, 1);
    assert.equal(first.body.created[0].learner.id, 10);
    assert.equal(t.sent.assigned.length, 1);

    const again = await request(t.app).post("/sessions/42/homework").set(t.as(20)).send(body);
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.skipped, 1);
    assert.equal(t.sent.assigned.length, 1, "no second notification");

    const wrongLearner = await request(t.app)
      .post("/sessions/42/homework")
      .set(t.as(20))
      .send({ ...body, learnerIds: [11] });
    assert.equal(wrongLearner.statusCode, 400);
  } finally {
    t.restore();
  }
});

test("homework can't be assigned before the session or on training sessions", async () => {
  const future = setup({ session: makeSession({ startAt: new Date(Date.now() + 60 * 60 * 1000) }) });
  try {
    const res = await request(future.app).post("/sessions/42/homework").set(future.as(20)).send({ templateId: "first-impressions-a1" });
    assert.equal(res.statusCode, 400);
  } finally {
    future.restore();
  }
  const training = setup({ session: makeSession({ type: "TRAINING" }) });
  try {
    const res = await request(training.app).post("/sessions/42/homework").set(training.as(20)).send({ templateId: "first-impressions-a1" });
    assert.equal(res.statusCode, 400);
  } finally {
    training.restore();
  }
});

test("learner gets the homework without answer keys and can autosave with a version check", async () => {
  const t = setup();
  try {
    const created = await request(t.app).post("/sessions/42/homework").set(t.as(20)).send({ templateId: "first-impressions-a1" });
    const id = created.body.created[0].id;

    const view = await request(t.app).get(`/homework/${id}`).set(t.as(10));
    assert.equal(view.statusCode, 200);
    assert.equal(view.body.homework.viewer, "learner");
    const json = JSON.stringify(view.body.homework.content);
    assert.ok(!json.includes('"answer"') && !json.includes('"answers"'), "no answer keys for learners");

    assert.equal((await request(t.app).get(`/homework/${id}`).set(t.as(11))).statusCode, 403);

    const save1 = await request(t.app)
      .patch(`/homework/${id}/answers`)
      .set(t.as(10))
      .send({ baseVersion: 0, answers: { t1: { i1: "c", i2: "d", i3: "a", i4: "f", i5: "b", i6: "e" }, junk: { x: 1 } } });
    assert.equal(save1.statusCode, 200);
    assert.equal(save1.body.answersVersion, 1);
    assert.equal(save1.body.completedTasks, 1);
    assert.equal(t.rows.get(id).status, "IN_PROGRESS");
    assert.equal(t.rows.get(id).answers.junk, undefined, "unknown tasks dropped");

    // A second tab still on version 0 must not overwrite newer work.
    const stale = await request(t.app).patch(`/homework/${id}/answers`).set(t.as(10)).send({ baseVersion: 0, answers: { t1: { i1: "a" } } });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.body.conflict, true);
    assert.equal(stale.body.answersVersion, 1);
    assert.equal(stale.body.answers.t1.i1, "c");

    const teacherWrite = await request(t.app).patch(`/homework/${id}/answers`).set(t.as(20)).send({ baseVersion: 1, answers: {} });
    assert.equal(teacherWrite.statusCode, 403);

    const impersonated = await request(t.app)
      .patch(`/homework/${id}/answers`)
      .set(t.as(30, { "x-test-as": "10" }))
      .send({ baseVersion: 1, answers: {} });
    assert.equal(impersonated.statusCode, 403, "view-as is read-only");
  } finally {
    t.restore();
  }
});

test("check marks one task without saving or submitting", async () => {
  const t = setup();
  try {
    const created = await request(t.app).post("/sessions/42/homework").set(t.as(20)).send({ templateId: "first-impressions-a1" });
    const id = created.body.created[0].id;
    const res = await request(t.app)
      .post(`/homework/${id}/check`)
      .set(t.as(10))
      .send({ taskId: "t3", answers: { t3: { i1: "I am from Cairo", i2: "I'm engineer" } } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.fields.i1, true);
    assert.equal(res.body.fields.i2, false);
    assert.equal(t.rows.get(id).answersVersion, 0, "check does not save");

    const open = await request(t.app).post(`/homework/${id}/check`).set(t.as(10)).send({ taskId: "t4" });
    assert.equal(open.statusCode, 400, "writing tasks are teacher-marked");
  } finally {
    t.restore();
  }
});

test("submit locks the homework, scores it and tells the teacher; review notifies the learner", async () => {
  const t = setup();
  try {
    const created = await request(t.app).post("/sessions/42/homework").set(t.as(20)).send({ templateId: "first-impressions-a1" });
    const id = created.body.created[0].id;

    const early = await request(t.app).patch(`/homework/${id}/review`).set(t.as(20)).send({ markReviewed: true });
    assert.equal(early.statusCode, 409, "can't mark reviewed before submission");

    const submit = await request(t.app)
      .post(`/homework/${id}/submit`)
      .set(t.as(10))
      .send({ baseVersion: 0, answers: { t1: { i1: "c", i2: "a" } } });
    assert.equal(submit.statusCode, 200);
    assert.equal(submit.body.homework.status, "SUBMITTED");
    assert.equal(submit.body.homework.marks.fields.t1.i1, true, "learner sees marks after submitting");
    assert.equal(t.rows.get(id).autoScore.byTask.t1.correct, 1);
    assert.equal(t.sent.submitted.length, 1);

    const locked = await request(t.app).patch(`/homework/${id}/answers`).set(t.as(10)).send({ baseVersion: 1, answers: {} });
    assert.equal(locked.statusCode, 409);

    const teacherView = await request(t.app).get(`/homework/${id}`).set(t.as(20));
    assert.equal(teacherView.body.homework.viewer, "teacher");
    assert.ok(JSON.stringify(teacherView.body.homework.content).includes('"answer"'), "teacher sees keys");

    const comment = await request(t.app)
      .patch(`/homework/${id}/review`)
      .set(t.as(20))
      .send({ comments: { t1: "Check number 2 again", nope: "ignored" }, overall: "Great effort!" });
    assert.equal(comment.statusCode, 200);
    assert.equal(t.sent.reviewed.length, 0, "saving comments alone doesn't notify");

    const learnerBefore = await request(t.app).get(`/homework/${id}`).set(t.as(10));
    assert.deepEqual(learnerBefore.body.homework.teacherComments, {}, "comments hidden until reviewed");

    const done = await request(t.app).patch(`/homework/${id}/review`).set(t.as(20)).send({ markReviewed: true });
    assert.equal(done.body.homework.status, "REVIEWED");
    assert.equal(t.sent.reviewed.length, 1);

    const learnerAfter = await request(t.app).get(`/homework/${id}`).set(t.as(10));
    assert.deepEqual(learnerAfter.body.homework.teacherComments, { t1: "Check number 2 again", overall: "Great effort!" });

    assert.equal((await request(t.app).delete(`/homework/${id}`).set(t.as(20))).statusCode, 409, "teachers can't delete submitted work");
  } finally {
    t.restore();
  }
});

test("lists show learners their own homework and teachers what they assigned", async () => {
  const t = setup();
  try {
    await request(t.app).post("/sessions/42/homework").set(t.as(20)).send({ templateId: "first-impressions-a1" });
    const learner = await request(t.app).get("/homework").set(t.as(10));
    assert.equal(learner.body.viewer, "learner");
    assert.equal(learner.body.assignments.length, 1);
    const other = await request(t.app).get("/homework").set(t.as(11));
    assert.equal(other.body.assignments.length, 0);
    const teacher = await request(t.app).get("/homework").set(t.as(20));
    assert.equal(teacher.body.viewer, "teacher");
    assert.equal(teacher.body.assignments[0].learner.name, "Nour");
  } finally {
    t.restore();
  }
});
