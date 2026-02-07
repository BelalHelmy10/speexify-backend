import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/app.js";

const e2eTest = process.env.RUN_E2E === "1" ? test : test.skip;

e2eTest("GET /health returns ok: true", async () => {
  const res = await request(app).get("/health");

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});
