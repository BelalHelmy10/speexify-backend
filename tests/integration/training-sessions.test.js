import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/admin/createRoutes.js";
import participantRouter from "../../src/routes/sessions/admin/participantRoutes.js";
import previewRouter from "../../src/routes/sessions/admin/previewRoutes.js";
import lifecycleRouter from "../../src/routes/sessions/lifecycle.js";
import { prisma } from "../../src/lib/prisma.js";

test("admin training booking includes multiple teachers and learners without credits", async () => {
  const originals = {
    userFindUnique: prisma.user.findUnique,
    userFindMany: prisma.user.findMany,
    userFindFirst: prisma.user.findFirst,
    sessionFindMany: prisma.session.findMany,
    sessionFindUnique: prisma.session.findUnique,
    sessionCreate: prisma.session.create,
    sessionUpdate: prisma.session.update,
    participantCreateMany: prisma.sessionParticipant.createMany,
    participantUpsert: prisma.sessionParticipant.upsert,
    participantUpdateMany: prisma.sessionParticipant.updateMany,
    queryRaw: prisma.$queryRaw,
    userPackageFindMany: prisma.userPackage.findMany,
    transaction: prisma.$transaction,
    executeRaw: prisma.$executeRaw,
    auditCreate: prisma.audit.create,
    notificationCreate: prisma.notification.create,
    suppressionFindMany: prisma.emailSuppression.findMany,
    deliveryCreate: prisma.notificationDelivery.create,
  };
  let created = null;
  let participants = [];
  let conflicts = false;
  let canceledSeat = null;
  let reassignedTeacher = undefined;
  const notifications = [];
  const deliveries = [];
  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    role: where.id === 99 ? "admin" : [7, 8].includes(where.id) ? "teacher" : "learner",
    email: `user${where.id}@example.com`,
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.user.findMany = async ({ where }) => where.id.in.map((id) => ({ id, role: [7, 8].includes(id) ? "teacher" : "learner", email: `user${id}@example.com`, isDisabled: false }));
  prisma.user.findFirst = async () => null;
  prisma.session.findMany = async () => conflicts ? [{ id: 5, title: "Existing session" }] : [];
  prisma.session.create = async ({ data }) => {
    created = { id: 91, status: "scheduled", ...data };
    return created;
  };
  prisma.session.update = async ({ data }) => { reassignedTeacher = data.teacherId; return { ...created, ...data }; };
  prisma.sessionParticipant.createMany = async ({ data }) => { participants = data; return { count: data.length }; };
  prisma.sessionParticipant.upsert = async ({ create }) => create;
  prisma.sessionParticipant.updateMany = async ({ where }) => { canceledSeat = where.userId; return { count: 1 }; };
  prisma.$queryRaw = async () => [];
  prisma.userPackage.findMany = async () => { throw new Error("Training must not inspect learner credits"); };
  prisma.$transaction = async (work) => work(prisma);
  prisma.$executeRaw = async () => [];
  prisma.audit.create = async () => ({ id: 1 });
  prisma.notification.create = async ({ data }) => { notifications.push(data); return { id: notifications.length, ...data }; };
  prisma.emailSuppression.findMany = async () => [];
  prisma.notificationDelivery.create = async ({ data }) => { deliveries.push(data); return { id: deliveries.length, ...data }; };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: { id: 99 } }; next(); });
  app.use(router);
  app.use(participantRouter);
  app.use(previewRouter);

  try {
    const payload = {
      type: "TRAINING",
      teacherIds: [7, 8],
      learnerIds: [10, 11],
      title: "Teaching methods workshop",
      startAt: "2026-10-10T10:00:00.000Z",
      endAt: "2026-10-10T11:00:00.000Z",
    };
    const booked = await request(app).post("/admin/sessions").send(payload);
    assert.equal(booked.statusCode, 201, JSON.stringify(booked.body));
    assert.equal(created.type, "TRAINING");
    assert.equal(created.teacherId, 7);
    assert.equal(created.trainingAdminId, 99);
    assert.equal(created.userId, null);
    assert.equal(created.capacity, null);
    assert.deepEqual(participants.map((p) => p.userId), [7, 8, 10, 11]);
    assert.equal(booked.body.session.id, 91);
    assert.deepEqual(notifications.map((item) => item.userId), [7, 8, 10, 11, 99]);
    assert.equal(notifications[0].title, "Training scheduled");
    assert.deepEqual(deliveries.map((item) => item.userId), [7, 8, 10, 11, 99]);
    assert.match(deliveries[0].subject, /training/i);

    const learnerOnly = await request(app).post("/admin/sessions").send({ ...payload, teacherIds: [], learnerIds: [10] });
    assert.equal(learnerOnly.statusCode, 201, JSON.stringify(learnerOnly.body));
    assert.equal(created.teacherId, null);
    assert.deepEqual(participants.map((p) => p.userId), [10]);
    const preview = await request(app).post("/admin/sessions/preview").send({ ...payload, teacherIds: [], learnerIds: [10] });
    assert.equal(preview.statusCode, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.canCreate, true);
    assert.equal(preview.body.credit.requiredCredits, 0);

    const activeTraining = { ...created, teacherId: 7, participants: [{ userId: 7, status: "booked" }] };
    prisma.session.findUnique = async () => activeTraining;
    const added = await request(app).post("/admin/sessions/91/participants").send({ userId: 12 });
    assert.equal(added.statusCode, 201, JSON.stringify(added.body));
    assert.deepEqual(added.body.userIds, [12]);
    assert.ok(notifications.some((item) => item.userId === 12));

    activeTraining.participants.push({ userId: 12, status: "booked" });
    const attendeeApp = express();
    attendeeApp.use(express.json());
    attendeeApp.use((req, _res, next) => { req.session = { user: { id: 12 } }; next(); });
    attendeeApp.use(lifecycleRouter);
    const leave = await request(attendeeApp).post("/sessions/91/cancel").send({});
    assert.equal(leave.statusCode, 200, JSON.stringify(leave.body));
    assert.equal(leave.body.scope, "participant");
    assert.equal(canceledSeat, 12);
    assert.equal(activeTraining.status, "scheduled");

    const removed = await request(app).delete("/admin/sessions/91/participants/7");
    assert.equal(removed.statusCode, 200, JSON.stringify(removed.body));
    assert.equal(canceledSeat, 7);
    assert.equal(reassignedTeacher, null);

    conflicts = true;
    const overlapping = await request(app).post("/admin/sessions").send(payload);
    assert.equal(overlapping.statusCode, 409);

    const wrongRole = await request(app).post("/admin/sessions").send({ ...payload, teacherIds: [10] });
    assert.equal(wrongRole.statusCode, 400);
  } finally {
    prisma.user.findUnique = originals.userFindUnique;
    prisma.user.findMany = originals.userFindMany;
    prisma.user.findFirst = originals.userFindFirst;
    prisma.session.findMany = originals.sessionFindMany;
    prisma.session.findUnique = originals.sessionFindUnique;
    prisma.session.create = originals.sessionCreate;
    prisma.session.update = originals.sessionUpdate;
    prisma.sessionParticipant.createMany = originals.participantCreateMany;
    prisma.sessionParticipant.upsert = originals.participantUpsert;
    prisma.sessionParticipant.updateMany = originals.participantUpdateMany;
    prisma.$queryRaw = originals.queryRaw;
    prisma.userPackage.findMany = originals.userPackageFindMany;
    prisma.$transaction = originals.transaction;
    prisma.$executeRaw = originals.executeRaw;
    prisma.audit.create = originals.auditCreate;
    prisma.notification.create = originals.notificationCreate;
    prisma.emailSuppression.findMany = originals.suppressionFindMany;
    prisma.notificationDelivery.create = originals.deliveryCreate;
  }
});
