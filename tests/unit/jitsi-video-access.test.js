import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  buildClassroomRoomName,
  legacyClassroomRoomName,
  signJitsiToken,
} from "../../src/services/jitsiTokenService.js";
import { createVideoAccessHandler } from "../../src/routes/sessions/videoAccess.js";

const SECRET = "x".repeat(48);

function decode(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("room name is unguessable when a secret is set, legacy otherwise", () => {
  assert.equal(buildClassroomRoomName(94, { secret: "" }), legacyClassroomRoomName(94));
  const a = buildClassroomRoomName(94, { secret: SECRET });
  const b = buildClassroomRoomName(95, { secret: SECRET });
  assert.match(a, /^speexify-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.ok(!a.includes("94"));
  assert.equal(a, buildClassroomRoomName(94, { secret: SECRET }), "stable per session");
});

test("token is a valid HS256 JWT scoped to one room", () => {
  const now = Date.UTC(2026, 10, 21, 12);
  const jwt = signJitsiToken(
    { room: "speexify-abc", user: { id: 7, name: "Lea" }, moderator: false },
    { secret: SECRET, appId: "speexify", domain: "meet.example", ttlSeconds: 600, now }
  );
  const [h, p, sig] = jwt.split(".");
  const expected = crypto.createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url");
  assert.equal(sig, expected);
  assert.equal(decode(h).alg, "HS256");
  const payload = decode(p);
  assert.equal(payload.room, "speexify-abc");
  assert.equal(payload.aud, "jitsi");
  assert.equal(payload.iss, "speexify");
  assert.equal(payload.sub, "meet.example");
  assert.equal(payload.exp - payload.iat, 600);
  assert.equal(payload.context.user.moderator, false);
  assert.equal(payload.context.user.id, "7");
  assert.equal(payload.context.user.email, undefined, "no email leaks into the token");
});

test("signing without a secret fails loudly", () => {
  assert.throws(() => signJitsiToken({ room: "r", user: { id: 1 } }, { secret: "" }));
});

test("handler denies unauthorized users without issuing a token", async () => {
  let signed = false;
  const handler = createVideoAccessHandler({
    authorize: async () => ({ allowed: false, reason: "classroom_admission_required" }),
    tokenConfigured: () => true,
    signToken: () => { signed = true; return "t"; },
  });
  const res = fakeRes();
  await handler({ params: { id: "94" }, viewUserId: 7 }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "classroom_admission_required");
  assert.equal(signed, false);
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("handler issues moderator token to teacher and member token to learner", async () => {
  const calls = [];
  const make = (role) => createVideoAccessHandler({
    authorize: async () => ({ allowed: true, sessionId: 94, userId: 3, role }),
    prismaClient: { user: { findUnique: async () => ({ id: 3, name: "T" }) } },
    tokenConfigured: () => true,
    roomNameFor: (id) => `room-${id}`,
    signToken: (args) => { calls.push(args); return "jwt"; },
    domain: () => "meet.example",
  });
  const teacherRes = fakeRes();
  await make("teacher")({ params: { id: "94" }, viewUserId: 3 }, teacherRes);
  assert.deepEqual(teacherRes.body, { domain: "meet.example", roomName: "room-94", jwt: "jwt", moderator: true });
  const learnerRes = fakeRes();
  await make("learner")({ params: { id: "94" }, viewUserId: 3 }, learnerRes);
  assert.equal(learnerRes.body.moderator, false);
  assert.equal(calls[1].moderator, false);
});

test("handler returns no token when token auth is not configured", async () => {
  const handler = createVideoAccessHandler({
    authorize: async () => ({ allowed: true, sessionId: 94, userId: 7, role: "learner" }),
    tokenConfigured: () => false,
    roomNameFor: legacyClassroomRoomName,
    domain: () => "meet.example",
  });
  const res = fakeRes();
  await handler({ params: { id: "94" }, viewUserId: 7 }, res);
  assert.equal(res.body.jwt, null);
  assert.equal(res.body.roomName, "speexify-classroom-94");
});
