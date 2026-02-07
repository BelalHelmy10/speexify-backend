import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { validateRequest } from "../../src/middleware/validateRequest.js";

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

test("validateRequest passes and normalizes valid query/body", () => {
  const middleware = validateRequest({
    query: z.object({ page: z.coerce.number().int().min(1) }),
    body: z.object({ name: z.string().trim().min(1) }).strict(),
  });

  const req = {
    query: { page: "2" },
    body: { name: "  Belal  " },
    params: {},
  };
  const res = createRes();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(req.query.page, 2);
  assert.equal(req.body.name, "Belal");
  assert.equal(res.statusCode, 200);
});

test("validateRequest returns 400 with detailed sources on invalid input", () => {
  const middleware = validateRequest({
    query: z.object({ page: z.coerce.number().int().min(1) }),
    body: z.object({ name: z.string().min(2) }).strict(),
  });

  const req = {
    query: { page: "0" },
    body: { name: "" },
    params: {},
  };
  const res = createRes();
  let nextCalled = false;

  middleware(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "Validation failed");
  assert.equal(Array.isArray(res.body.details), true);

  const sources = new Set(res.body.details.map((item) => item.source));
  assert.equal(sources.has("query"), true);
  assert.equal(sources.has("body"), true);
});
