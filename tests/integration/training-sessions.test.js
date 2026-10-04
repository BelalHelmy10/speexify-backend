import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/admin/createRoutes.js";
import { prisma } from "../../src/lib/prisma.js";

test("admin training booking reserves the teacher without learners, credits, or earnings", async () => {
  const originals = {
    userFindUnique: prisma.user.findUnique,
    sessionFindMany: prisma.session.findMany,
    sessionCreate: prisma.session.create,
    transaction: prisma.$transaction,
    executeRaw: prisma.$executeRaw,
    auditCreate: prisma.audit.create,
    notificationCreate: prisma.notification.create,
    suppressionFindMany: prisma.emailSuppression.findMany,
    deliveryCreate: prisma.notificationDelivery.create,
  };
  let created = null;
  let conflicts = false;
  const notifications = [];
  const deliveries = [];
  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    role: where.id === 99 ? "admin" : "teacher",
    email: `user${where.id}@example.com`,
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findMany = async () => conflicts ? [{ id: 5, title: "Existing session" }] : [];
  prisma.session.create = async ({ data }) => {
    created = { id: 91, status: "scheduled", ...data };
    return created;
  };
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

  try {
    const payload = {
      type: "TRAINING",
      teacherId: 7,
      title: "Teaching methods workshop",
      startAt: "2026-10-10T10:00:00.000Z",
      endAt: "2026-10-10T11:00:00.000Z",
    };
    const booked = await request(app).post("/admin/sessions").send(payload);
    assert.equal(booked.statusCode, 201);
    assert.equal(created.type, "TRAINING");
    assert.equal(created.teacherId, 7);
    assert.equal(created.trainingAdminId, 99);
    assert.equal(created.userId, null);
    assert.equal(created.capacity, null);
    assert.equal(booked.body.session.id, 91);
    assert.deepEqual(notifications.map((item) => item.userId), [7, 99]);
    assert.equal(notifications[0].title, "Teacher training scheduled");
    assert.deepEqual(deliveries.map((item) => item.userId), [7, 99]);
    assert.match(deliveries[0].subject, /training/i);

    conflicts = true;
    const overlapping = await request(app).post("/admin/sessions").send(payload);
    assert.equal(overlapping.statusCode, 409);

    const withLearner = await request(app).post("/admin/sessions").send({ ...payload, learnerId: 8 });
    assert.equal(withLearner.statusCode, 400);
  } finally {
    prisma.user.findUnique = originals.userFindUnique;
    prisma.session.findMany = originals.sessionFindMany;
    prisma.session.create = originals.sessionCreate;
    prisma.$transaction = originals.transaction;
    prisma.$executeRaw = originals.executeRaw;
    prisma.audit.create = originals.auditCreate;
    prisma.notification.create = originals.notificationCreate;
    prisma.emailSuppression.findMany = originals.suppressionFindMany;
    prisma.notificationDelivery.create = originals.deliveryCreate;
  }
});
