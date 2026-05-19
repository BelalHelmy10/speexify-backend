import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

delete process.env.OBS_METRICS_TOKEN;
const { default: app } = await import("../../src/app.js");

const e2eTest = process.env.RUN_E2E === "1" ? test : test.skip;

e2eTest("GET /health returns ok: true", async () => {
  const res = await request(app).get("/health");

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

e2eTest("GET /metrics denies access when token is not configured", async () => {
  const res = await request(app).get("/metrics");

  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Unauthorized" });
});
