import test from "node:test";
import assert from "node:assert/strict";
import { csrfMiddleware, csrfErrorHandler } from "../../src/middleware/csrf.js";

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

test("csrfMiddleware skips checks in test mode", () => {
  const req = {
    method: "POST",
    originalUrl: "/api/me",
    path: "/api/me",
  };
  const res = createRes();
  let nextCalled = false;

  csrfMiddleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test("csrfErrorHandler returns 403 for invalid CSRF tokens", () => {
  const req = { method: "POST", originalUrl: "/api/me" };
  const res = createRes();
  let nextCalled = false;

  csrfErrorHandler({ code: "EBADCSRFTOKEN" }, req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Invalid CSRF token" });
});

test("csrfErrorHandler passes non-CSRF errors through", () => {
  const req = {};
  const res = createRes();
  let forwardedError = null;

  const otherError = new Error("boom");
  csrfErrorHandler(otherError, req, res, (err) => {
    forwardedError = err;
  });

  assert.equal(forwardedError, otherError);
});
