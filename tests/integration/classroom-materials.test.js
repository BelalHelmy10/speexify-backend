import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import router from "../../src/routes/sessions/materials.js";
import { prisma } from "../../src/lib/prisma.js";
import { deleteMaterial } from "../../src/services/classroomMaterialStorage.js";
import { MAX_CLASSROOM_PDF_BYTES } from "../../src/services/classroomMaterialStorage.js";

test("only the teacher can upload a PDF and only classroom members can read it", async () => {
  const originals = {
    user: prisma.user.findUnique,
    session: prisma.session.findUnique,
    create: prisma.classroomMaterial.create,
    findFirst: prisma.classroomMaterial.findFirst,
    findMany: prisma.classroomMaterial.findMany,
  };
  let storedMaterial = null;
  let sessionStatus = "scheduled";
  const uploadedFiles = [];
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
    status: sessionStatus,
    participants: [],
  });
  prisma.classroomMaterial.create = async ({ data }) => {
    storedMaterial = { ...data, createdAt: new Date() };
    uploadedFiles.push(data.filename);
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

    const partial = await request(app)
      .get(`/sessions/42/materials/${storedMaterial.id}/file`)
      .set("x-test-user", "10").set("Range", "bytes=0-4");
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers["accept-ranges"], "bytes");
    assert.deepEqual(partial.body, Buffer.from("%PDF-"));
    assert.equal(partial.headers["cache-control"], "private, no-store");

    const invalidRange = await request(app)
      .get(`/sessions/42/materials/${storedMaterial.id}/file`)
      .set("x-test-user", "10").set("Range", "bytes=99999-100000");
    assert.equal(invalidRange.statusCode, 416);

    const outsider = await request(app)
      .get(`/sessions/42/materials/${storedMaterial.id}/file`)
      .set("x-test-user", "30");
    assert.equal(outsider.statusCode, 403);

    const objectCount = globalThis.materialStorageTestObjects?.size;
    const create = prisma.classroomMaterial.create;
    prisma.classroomMaterial.create = async () => { throw new Error("Database unavailable"); };
    const failed = await request(app).post("/sessions/42/materials")
      .set("x-test-user", "20").attach("file", pdf, "rollback.pdf");
    assert.equal(failed.statusCode, 500);
    if (objectCount != null) assert.equal(globalThis.materialStorageTestObjects.size, objectCount);
    prisma.classroomMaterial.create = create;

    const oversized = await request(app).post("/sessions/42/materials")
      .set("x-test-user", "20")
      .attach("file", Buffer.alloc(MAX_CLASSROOM_PDF_BYTES + 1), "too-large.pdf");
    assert.equal(oversized.statusCode, 413);
    if (process.env.CLASSROOM_CLOUDINARY_MALWARE_SCAN === "true") {
      const count = globalThis.materialStorageTestObjects.size;
      globalThis.rejectNextCloudinaryPdf = true;
      const rejected = await request(app).post("/sessions/42/materials")
        .set("x-test-user", "20").attach("file", pdf, "rejected.pdf");
      assert.equal(rejected.statusCode, 422);
      assert.equal(globalThis.materialStorageTestObjects.size, count);
    }

    if (globalThis.materialStorageTestObjects) {
      let release;
      let ready;
      let entered = 0;
      const bothUploading = new Promise((resolve) => { ready = resolve; });
      globalThis.materialStorageTestGate = {
        entered: () => { if (++entered === 2) ready(); },
        wait: new Promise((resolve) => { release = resolve; }),
      };
      const uploadRequests = [1, 2].map((number) => request(app)
        .post("/sessions/42/materials").set("x-test-user", "20")
        .attach("file", pdf, `concurrent-${number}.pdf`).then((response) => response));
      try {
        await Promise.race([bothUploading, new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Concurrent uploads never started")), 3000).unref())]);
        const busy = await request(app).post("/sessions/42/materials")
          .set("x-test-user", "20").attach("file", pdf, "busy.pdf");
        assert.equal(busy.statusCode, 429);
        assert.equal(busy.headers["retry-after"], "5");
        const available = await request(app).get("/sessions/42/materials").set("x-test-user", "10");
        assert.equal(available.statusCode, 200);
      } finally {
        release();
        globalThis.materialStorageTestGate = null;
        const completed = await Promise.all(uploadRequests);
        assert.deepEqual(completed.map((response) => response.statusCode), [201, 201]);
      }
    }

    sessionStatus = "completed";
    const pastSessionUpload = await request(app)
      .post("/sessions/42/materials")
      .set("x-test-user", "20")
      .attach("file", pdf, "past-class.pdf");
    assert.equal(pastSessionUpload.statusCode, 201);

    sessionStatus = "canceled";
    const canceledUpload = await request(app)
      .post("/sessions/42/materials")
      .set("x-test-user", "20")
      .attach("file", pdf, "canceled-class.pdf");
    assert.equal(canceledUpload.statusCode, 403);
  } finally {
    prisma.user.findUnique = originals.user;
    prisma.session.findUnique = originals.session;
    prisma.classroomMaterial.create = originals.create;
    prisma.classroomMaterial.findFirst = originals.findFirst;
    prisma.classroomMaterial.findMany = originals.findMany;
    await Promise.all(uploadedFiles.map((filename) => deleteMaterial(42, filename)));
  }
});
