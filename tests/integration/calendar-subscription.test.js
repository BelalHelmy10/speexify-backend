import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import request from "supertest";

const prisma = {
  user: { findUnique() {}, update() {} },
  calendarSubscription: { upsert() {}, findUnique() {}, deleteMany() {} },
  calendarFeedToken: { findUnique() {}, updateMany() {} },
  session: { findMany() {} },
  $transaction() {},
};
globalThis.prisma = prisma;
const { default: calendarRoutes } = await import("../../src/routes/calendar.js");

async function createCalendarApp(t) {
  const feeds = new Map();
  const accounts = new Map([
    [1, { id: 1, isDisabled: false }],
    [2, { id: 2, isDisabled: false }],
  ]);
  t.mock.method(prisma.user, "findUnique", async ({ where }) => accounts.get(where.id));
  t.mock.method(prisma.user, "update", async () => ({}));
  t.mock.method(prisma.calendarSubscription, "upsert", async ({ where, create }) => {
    if (!feeds.has(where.userId)) feeds.set(where.userId, create);
    return feeds.get(where.userId);
  });
  t.mock.method(prisma.calendarSubscription, "findUnique", async ({ where }) => {
    const feed = [...feeds.values()].find((item) => item.feedId === where.feedId);
    if (!feed) return null;
    return accounts.get(feed.userId).isDisabled === where.user.isDisabled ? feed : null;
  });
  t.mock.method(prisma.calendarSubscription, "deleteMany", async ({ where }) => {
    feeds.delete(where.userId);
  });
  t.mock.method(prisma.calendarFeedToken, "updateMany", async () => ({ count: 1 }));
  t.mock.method(prisma, "$transaction", (queries) => Promise.all(queries));

  const app = express();
  app.use((req, _res, next) => {
    const userId = Number(req.get("test-user"));
    req.session = {
      user: accounts.get(userId),
      asUserId: Number(req.get("test-view-user")) || undefined,
    };
    next();
  });
  app.use("/api", calendarRoutes);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { client: request(server), accounts };
}

const exportPath = "/api/calendar/export-link";

function feedPath(url) {
  const { pathname, search } = new URL(url);
  return pathname + search;
}

test("a private subscription keeps its URL and updates when the same URL is fetched again", async (t) => {
  const { client } = await createCalendarApp(t);
  const session = {
    id: 14,
    title: "محادثة, المجموعة; A 🎓 ".repeat(7).trim(),
    startAt: new Date("2026-12-02T08:00:00Z"),
    endAt: null,
    updatedAt: new Date("2026-11-23T08:00:00Z"),
    status: "scheduled",
    teacher: { name: "Teacher Name" },
    joinUrl: "https://speexify.com/classroom/14",
  };
  const loadSessions = t.mock.method(prisma.session, "findMany", async ({ where }) => {
    assert.deepEqual(where, {
      status: { not: "canceled" },
      OR: [
        { participants: { some: { userId: 1, status: { not: "canceled" } } } },
        { userId: 1 },
        { teacherId: 1 },
        { trainingAdminId: 1 },
      ],
    });
    return session.status === where.status.not ? [] : [session];
  });

  await client.get(exportPath).expect(401);
  await client.get(exportPath).set("test-user", "1").set("test-view-user", "2").expect(403);
  const links = await Promise.all([
    client.get(exportPath).set("test-user", "1").expect(200),
    client.get(exportPath).set("test-user", "1").expect(200),
  ]);
  const [{ body, headers }, repeated] = links;
  assert.deepEqual(repeated.body, body);
  assert.equal(body.expiresAt, null);
  assert.equal(body.webcalUrl, body.httpsUrl.replace(/^https?:\/\//, "webcal://"));
  assert.equal(headers["cache-control"], "private, no-store");

  const otherAccount = await client.get(exportPath).set("test-user", "2").expect(200);
  assert.notEqual(otherAccount.body.httpsUrl, body.httpsUrl);

  const path = feedPath(body.httpsUrl);
  const replacement = path.endsWith("a") ? "b" : "a";
  await client.get(path.slice(0, -1) + replacement).expect(401);
  assert.equal(loadSessions.mock.callCount(), 0);

  const first = await client.get(path).expect(200).expect("Content-Type", /text\/calendar/);
  assert.equal(first.headers["cache-control"], "private, no-store");
  assert.match(first.text, /UID:speexify-session-14@speexify\r\n/);
  assert.match(first.text, /DTSTART:20261202T080000Z\r\nDTEND:20261202T090000Z/);
  assert.match(first.text, /LAST-MODIFIED:20261123T080000Z/);
  assert.ok(first.text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75));
  assert.ok(first.text.replace(/\r\n /g, "").includes("SUMMARY:محادثة\\, المجموعة\\; A 🎓"));
  await client.get(path).set("If-None-Match", first.headers.etag).expect(304);

  session.startAt = new Date("2026-12-02T12:00:00Z");
  session.updatedAt = new Date("2026-11-23T09:00:00Z");
  const moved = await client.get(path).set("If-None-Match", first.headers.etag).expect(200);
  assert.match(moved.text, /UID:speexify-session-14@speexify\r\n/);
  assert.match(moved.text, /DTSTART:20261202T120000Z/);
  assert.match(moved.text, /LAST-MODIFIED:20261123T090000Z/);

  session.status = "canceled";
  const canceled = await client.get(path).set("If-None-Match", moved.headers.etag).expect(200);
  assert.doesNotMatch(canceled.text, /BEGIN:VEVENT/);
});

test("revocation replaces the subscription while legacy links honor their original expiry", async (t) => {
  const { client, accounts } = await createCalendarApp(t);
  const legacy = randomBytes(32).toString("base64url");
  const expired = randomBytes(32).toString("base64url");
  const legacyPath = `/api/calendar.ics?token=${legacy}`;
  const legacyExpiry = new Map([
    [createHash("sha256").update(legacy).digest("hex"), new Date(Date.now() + 60_000)],
    [createHash("sha256").update(expired).digest("hex"), new Date(0)],
  ]);
  let legacyRevoked = false;

  t.mock.method(prisma.session, "findMany", async () => []);
  t.mock.method(prisma.calendarFeedToken, "findUnique", async ({ where }) => {
    assert.equal(where.revokedAt, null);
    assert.ok(where.expiresAt.gt instanceof Date);
    assert.deepEqual(where.user, { isDisabled: false, deletedAt: null });
    return !legacyRevoked && legacyExpiry.get(where.tokenHash) > where.expiresAt.gt
      ? { id: 4, userId: 1 }
      : null;
  });
  t.mock.method(prisma.calendarFeedToken, "updateMany", async ({ data }) => {
    if (data.revokedAt) legacyRevoked = true;
    return { count: 1 };
  });

  const original = await client.get(exportPath).set("test-user", "1").expect(200);
  const path = feedPath(original.body.httpsUrl);
  await client.get(path).expect(200);
  await client.get(legacyPath).expect(200);
  await client.get(`/api/calendar.ics?token=${expired}`).expect(401);

  accounts.get(1).isDisabled = true;
  await client.get(path).expect(401);
  accounts.get(1).isDisabled = false;

  await client.post(`${exportPath}/revoke`).set("test-user", "1").expect(200);
  await client.get(path).expect(401);
  await client.get(legacyPath).expect(401);

  const replacement = await client.get(exportPath).set("test-user", "1").expect(200);
  assert.notEqual(replacement.body.httpsUrl, original.body.httpsUrl);
  await client.get(feedPath(replacement.body.httpsUrl)).expect(200);
});
