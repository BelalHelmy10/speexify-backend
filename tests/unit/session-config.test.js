import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_MAX_AGE_MS,
  sessionCookieOptions,
} from "../../src/config/session.js";

test("session cookies have a fixed 30 day lifetime", () => {
  assert.equal(SESSION_MAX_AGE_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(sessionCookieOptions.maxAge, SESSION_MAX_AGE_MS);
});
