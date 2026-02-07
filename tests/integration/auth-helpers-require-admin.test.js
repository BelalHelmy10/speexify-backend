import test from "node:test";
import assert from "node:assert/strict";
import { requireAdmin } from "../../src/middleware/auth-helpers.js";

function createRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test("requireAdmin returns 401 when user is missing", () => {
  const req = {};
  const res = createRes();
  let nextCalled = false;

  requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: "Not authenticated" });
});

test("requireAdmin returns 403 for non-admin users", () => {
  const req = { user: { id: 4, role: "teacher" } };
  const res = createRes();
  let nextCalled = false;

  requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Admin only" });
});

test("requireAdmin allows admin users", () => {
  const req = { user: { id: 1, role: "admin" } };
  const res = createRes();
  let nextCalled = false;

  requireAdmin(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});
