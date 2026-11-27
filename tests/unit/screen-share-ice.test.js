import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { buildIceServers } from "../../src/services/iceServers.js";
import { createIceServersHandler } from "../../src/routes/sessions/screenShare.js";

const STUN = ["stun:stun.example.test:3478"];

test("STUN only when no TURN relay is configured", () => {
  assert.deepEqual(buildIceServers(10, { stunUrls: STUN, turnUrls: [] }), [{ urls: STUN }]);
});

test("TURN with a shared secret gets short-lived coturn credentials", () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const [stun, turn] = buildIceServers(10, {
    stunUrls: STUN,
    turnUrls: ["turn:turn.example.test:3478", "turns:turn.example.test:5349"],
    turnSecret: "s3cret",
    ttlSeconds: 3600,
    now,
  });
  assert.deepEqual(stun, { urls: STUN });
  const expiry = Math.floor(now / 1000) + 3600;
  assert.equal(turn.username, `${expiry}:10`);
  assert.equal(turn.credential, crypto.createHmac("sha1", "s3cret").update(`${expiry}:10`).digest("base64"));
  assert.equal(turn.urls.length, 2);
});

test("TURN with a fixed username and credential", () => {
  const servers = buildIceServers(10, {
    stunUrls: [],
    turnUrls: ["turn:turn.example.test:3478"],
    turnSecret: "",
    turnUsername: "speexify",
    turnCredential: "pass",
  });
  assert.deepEqual(servers, [{ urls: ["turn:turn.example.test:3478"], username: "speexify", credential: "pass" }]);
});

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("only classroom members get ICE servers", async () => {
  const handler = createIceServersHandler({
    authorize: async ({ userId }) => (userId === 10 ? { allowed: true, userId: 10 } : { allowed: false, reason: "forbidden_classroom_room" }),
    build: (userId) => [{ urls: [`stun:for-${userId}`] }],
  });
  const ok = fakeRes();
  await handler({ params: { id: "42" }, viewUserId: 10, user: { id: 10 } }, ok);
  assert.deepEqual(ok.body, { iceServers: [{ urls: ["stun:for-10"] }], refreshAfterSeconds: 1800 });
  assert.equal(ok.headers["Cache-Control"], "no-store");

  const denied = fakeRes();
  await handler({ params: { id: "42" }, viewUserId: 11, user: { id: 11 } }, denied);
  assert.equal(denied.statusCode, 403);
});
