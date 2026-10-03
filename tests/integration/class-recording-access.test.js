import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import adminRecordingRoutes from "../../src/routes/admin/recordingsRoutes.js";
import jibriRecordingRoutes from "../../src/routes/jibriRecordings.js";
import { prisma } from "../../src/lib/prisma.js";

test("a non-admin cannot list or open private class recordings", async () => {
  const originalFindUnique = prisma.user.findUnique;
  prisma.user.findUnique = async () => ({
    id: 7,
    role: "teacher",
    isDisabled: false,
    passwordChangedAt: null,
  });
  const app = express();
  app.use((req, _res, next) => {
    req.session = { user: { id: 7 } };
    next();
  });
  app.use(adminRecordingRoutes);
  try {
    const [list, playback] = await Promise.all([
      request(app).get("/admin/recordings"),
      request(app).get("/admin/recordings/1/play"),
    ]);
    assert.equal(list.statusCode, 403);
    assert.equal(playback.statusCode, 403);
  } finally {
    prisma.user.findUnique = originalFindUnique;
  }
});

test("Jibri registration rejects requests without its secret", async () => {
  const app = express();
  app.use(express.json());
  app.use(jibriRecordingRoutes);
  const response = await request(app)
    .post("/recordings")
    .send({ sessionId: 42, key: "class-recordings/session-42/speexify-classroom-42_test.mp4" });
  assert.equal(response.statusCode, 401);
});
