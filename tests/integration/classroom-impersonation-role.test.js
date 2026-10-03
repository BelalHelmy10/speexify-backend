import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/crud.js";
import { prisma } from "../../src/lib/prisma.js";

const classroom = {
  id: 77,
  type: "ONE_ON_ONE",
  status: "completed",
  teacherId: 59,
  userId: 10,
  user: { id: 10, name: "Learner" },
  teacher: { id: 59, name: "Teacher" },
  participants: [],
  feedback: null,
};

async function getClassroomAs(actor, viewedUserId) {
  const originalUserFindUnique = prisma.user.findUnique;
  const originalSessionFindUnique = prisma.session.findUnique;

  prisma.user.findUnique = async () => ({
    ...actor,
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => classroom;

  const app = express();
  app.use((req, _res, next) => {
    req.session = {
      user: { id: actor.id },
      ...(viewedUserId ? { asUserId: viewedUserId } : {}),
    };
    next();
  });
  app.use(router);

  try {
    return await request(app).get(`/sessions/${classroom.id}`);
  } finally {
    prisma.user.findUnique = originalUserFindUnique;
    prisma.session.findUnique = originalSessionFindUnique;
  }
}

test("Mariam and an admin viewing as Mariam both get the teacher classroom", async () => {
  const teacher = await getClassroomAs({ id: 59, role: "teacher" });
  const impersonatedTeacher = await getClassroomAs({ id: 99, role: "admin" }, 59);

  assert.equal(teacher.statusCode, 200);
  assert.equal(teacher.body.session.isTeacher, true);
  assert.equal(impersonatedTeacher.statusCode, 200);
  assert.equal(impersonatedTeacher.body.session.isTeacher, true);
  assert.equal(impersonatedTeacher.body.session.isLearner, false);
});

test("an admin viewing as the learner still gets the learner classroom", async () => {
  const impersonatedLearner = await getClassroomAs({ id: 99, role: "admin" }, 10);

  assert.equal(impersonatedLearner.statusCode, 200);
  assert.equal(impersonatedLearner.body.session.isTeacher, false);
  assert.equal(impersonatedLearner.body.session.isLearner, true);
});
