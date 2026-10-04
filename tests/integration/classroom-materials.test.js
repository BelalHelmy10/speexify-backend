import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/materials.js";
import { prisma } from "../../src/lib/prisma.js";
import { uploadRoot } from "../../src/lib/uploadStorage.js";

test("only the teacher can upload a PDF and only classroom members can read it", async () => {
  const originals = {
    user: prisma.user.findUnique,
    session: prisma.session.findUnique,
    create: prisma.classroomMaterial.create,
    findFirst: prisma.classroomMaterial.findFirst,
    findMany: prisma.classroomMaterial.findMany,
  };
  let storedMaterial = null;
  prisma.user.findUnique = async ({ where }) => ({
    id: where.id,
    role: where.id === 20 ? "teacher" : "learner",
    isDisabled: false,
    passwordChangedAt: null,
  });
  prisma.session.findUnique = async () => ({
    id: 42,
    teacherId: 20,
    userId: 10,
    status: "scheduled",
    participants: [],
  });
  prisma.classroomMaterial.create = async ({ data }) => {
    storedMaterial = { ...data, createdAt: new Date() };
    return storedMaterial;
  };
  prisma.classroomMaterial.findFirst = async ({ where }) =>
    storedMaterial?.id === where.id && where.sessionId === 42 ? storedMaterial : null;
  prisma.classroomMaterial.findMany = async () => storedMaterial ? [storedMaterial] : [];

  const app = express();
  app.use((req, _res, next) => {
    req.session = { user: { id: Number(req.headers["x-test-user"] || 20) } };
    next();
  });
  app.use(router);

  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n");
  try {
    const learnerUpload = await request(app)
      .post("/sessions/42/materials")
      .set("x-test-user", "10")
      .attach("file", pdf, "notes.pdf");
    assert.equal(learnerUpload.statusCode, 403);

    const invalidUpload = await request(app)
      .post("/sessions/42/materials")
      .set("x-test-user", "20")
      .attach("file", Buffer.from("not a pdf"), "notes.pdf");
    assert.equal(invalidUpload.statusCode, 400);

    const upload = await request(app)
      .post("/sessions/42/materials")
      .set("x-test-user", "20")
      .attach("file", pdf, "notes.pdf");
    assert.equal(upload.statusCode, 201);
    assert.equal(upload.body.material.title, "notes.pdf");
    assert.match(upload.body.material.fileUrl, /^\/api\/sessions\/42\/materials\//);

    const list = await request(app)
      .get("/sessions/42/materials")
      .set("x-test-user", "10");
    assert.equal(list.statusCode, 200);
    assert.equal(list.body.materials[0]._id, upload.body.material._id);

    const file = await request(app)
      .get(`/sessions/42/materials/${storedMaterial.id}/file`)
      .set("x-test-user", "10");
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "application/pdf");
    assert.deepEqual(file.body, pdf);

    const outsider = await request(app)
      .get(`/sessions/42/materials/${storedMaterial.id}/file`)
      .set("x-test-user", "30");
    assert.equal(outsider.statusCode, 403);
  } finally {
    prisma.user.findUnique = originals.user;
    prisma.session.findUnique = originals.session;
    prisma.classroomMaterial.create = originals.create;
    prisma.classroomMaterial.findFirst = originals.findFirst;
    prisma.classroomMaterial.findMany = originals.findMany;
    if (storedMaterial) {
      await fs.rm(path.join(uploadRoot, "classroom-materials", storedMaterial.filename), { force: true });
    }
  }
});
