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

test("production CSRF requires the session-bound header token", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";

  try {
    const session = {};
    const tokenRequest = {
      method: "GET",
      originalUrl: "/api/csrf-token",
      path: "/api/csrf-token",
      session,
      get: () => undefined,
    };

    csrfMiddleware(tokenRequest, createRes(), () => {});
    const token = tokenRequest.csrfToken();

    const validRequest = {
      method: "POST",
      originalUrl: "/api/me",
      path: "/api/me",
      session,
      get: (name) => (name === "csrf-token" ? token : undefined),
    };
    let validError = null;
    let validNextCalled = false;
    csrfMiddleware(validRequest, createRes(), (error) => {
      validError = error || null;
      validNextCalled = true;
    });
    assert.equal(validError, null);
    assert.equal(validNextCalled, true);

    const invalidRequest = {
      ...validRequest,
      get: () => "wrong-token",
    };
    let invalidError = null;
    csrfMiddleware(invalidRequest, createRes(), (error) => {
      invalidError = error;
    });
    assert.equal(invalidError?.code, "EBADCSRFTOKEN");
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
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
