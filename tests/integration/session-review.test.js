import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/review.js";
import { prisma } from "../../src/lib/prisma.js";

function createSession(overrides = {}) {
  return {
    id: 42,
    title: "Pronunciation practice",
    startAt: new Date("2026-10-10T10:00:00.000Z"),
    endAt: new Date("2026-10-10T11:00:00.000Z"),
    completedAt: new Date("2026-10-10T11:01:00.000Z"),
    status: "completed",
    userId: 10,
    teacherId: 20,
    teacher: { id: 20, name: "Teacher", email: "teacher@example.test" },
    participants: [],
    resourcesUsedAt: {},
    resourcesUsed: [
      {
        id: "library-pdf",
        title: "Lesson PDF",
        firstOpenedAt: "2026-10-10T10:15:00.000Z",
        snapshot: {
          title: "Lesson PDF",
          sourceType: "pdf",
          fileUrl: "https://cdn.sanity.io/lesson.pdf",
        },
      },
      { id: "upload-material-1", title: "Teacher notes" },
    ],
    classroomMaterials: [
      {
        id: "material-1",
        title: "Teacher notes.pdf",
        size: 1200,
        createdAt: new Date("2026-10-10T10:10:00.000Z"),
      },
      {
        id: "not-opened",
        title: "Not opened.pdf",
        size: 800,
        createdAt: new Date("2026-10-10T10:11:00.000Z"),
      },
    ],
    ...overrides,
  };
}

test("completed review is learner-only and returns only opened materials", async () => {
  const originals = {
    user: prisma.user.findUnique,
    session: prisma.session.findUnique,
    annotations: prisma.classroomAnnotation.findMany,
  };
  let session = createSession();

  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    role: where.id === 20 ? "teacher" : "learner",
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => session;
  prisma.classroomAnnotation.findMany = async () => [{
    userId: 20,
    resourceId: "library-pdf",
    payload: { strokes: [] },
    version: 1,
    updatedAt: new Date("2026-10-10T10:45:00.000Z"),
  }];

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"] || 10) } };
    next();
  });
  app.use(router);

  try {
    const learner = await request(app)
      .get("/sessions/42/review")
      .set("x-test-user", "10");
    assert.equal(learner.statusCode, 200);
    assert.deepEqual(learner.body.review.resources.map((item) => item.id), [
      "library-pdf",
      "upload-material-1",
    ]);
    assert.deepEqual(learner.body.review.materials.map((item) => item._id), [
      "upload-material-1",
    ]);

    const annotations = await request(app)
      .get("/sessions/42/review/annotations?resourceId=library-pdf")
      .set("x-test-user", "10");
    assert.equal(annotations.statusCode, 200);
    assert.equal(annotations.body.annotations[0].userId, 20);

    const unopened = await request(app)
      .get("/sessions/42/review/annotations?resourceId=not-opened")
      .set("x-test-user", "10");
    assert.equal(unopened.statusCode, 404);

    const teacher = await request(app)
      .get("/sessions/42/review")
      .set("x-test-user", "20");
    assert.equal(teacher.statusCode, 403);

    session = createSession({
      status: "scheduled",
      endAt: new Date(Date.now() + 60_000),
    });
    const early = await request(app)
      .get("/sessions/42/review")
      .set("x-test-user", "10");
    assert.equal(early.statusCode, 409);
    assert.equal(early.body.code, "REVIEW_NOT_READY");
  } finally {
    prisma.user.findUnique = originals.user;
    prisma.session.findUnique = originals.session;
    prisma.classroomAnnotation.findMany = originals.annotations;
  }
});
