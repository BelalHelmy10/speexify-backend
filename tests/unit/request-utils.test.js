import test from "node:test";
import assert from "node:assert/strict";
import { getClientIP } from "../../src/webrtcSignaling/requestUtils.js";

test("getClientIP prefers x-forwarded-for first IP", () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.8, 198.51.100.7" },
    socket: { remoteAddress: "127.0.0.1" },
  };

  assert.equal(getClientIP(req), "203.0.113.8");
});

test("getClientIP falls back to remoteAddress", () => {
  const req = {
    headers: {},
    socket: { remoteAddress: "10.0.0.15" },
  };

  assert.equal(getClientIP(req), "10.0.0.15");
});

test("getClientIP returns unknown when no source is available", () => {
  const req = { headers: {}, socket: null };
  assert.equal(getClientIP(req), "unknown");
});
