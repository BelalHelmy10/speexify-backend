import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import app from "../../src/app.js";

const e2eTest = process.env.RUN_E2E === "1" ? test : test.skip;

e2eTest("GET /api/csrf-token returns a token", async () => {
  const res = await request(app).get("/api/csrf-token");

  assert.equal(res.statusCode, 200);
  assert.equal(typeof res.body?.csrfToken, "string");
  assert.ok(res.body.csrfToken.length > 10);
});
