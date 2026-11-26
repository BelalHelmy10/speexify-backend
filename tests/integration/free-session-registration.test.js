import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import bcrypt from "bcryptjs";
import express from "express";
import request from "supertest";

const accounts = new Map();
const trialRequests = new Map();
const codes = new Map();
const sent = [];
const session = {};
let failNextTrial = false;

const hash = (value) => createHash("sha256").update(value).digest("hex");
const prisma = {
  user: {
    findUnique: async ({ where }) => accounts.get(where.email) ??
      [...accounts.values()].find((user) => user.id === where.id) ?? null,
    findMany: async () => [],
    create: async ({ data }) => {
      if (accounts.has(data.email)) throw Object.assign(new Error("Unique email"), { code: "P2002" });
      const user = { ...data, id: accounts.size + 1 };
      accounts.set(data.email, user);
      const { hashedPassword: _password, ...publicUser } = user;
      return publicUser;
    },
  },
  verificationCode: {
    findUnique: async ({ where }) => codes.get(where.email),
    updateMany: async ({ where, data }) => {
      const entry = codes.get(where.email);
      if (entry?.codeHash !== where.codeHash || entry.attempts >= where.attempts.lt) return { count: 0 };
      codes.set(where.email, { ...entry, attempts: entry.attempts + data.attempts.increment });
      return { count: 1 };
    },
    deleteMany: async ({ where }) => {
      const entry = codes.get(where.email);
      if (!entry || entry.codeHash !== where.codeHash ||
          entry.expiresAt !== where.expiresAt.equals ||
          entry.expiresAt <= where.expiresAt.gt || entry.attempts >= where.attempts.lt) return { count: 0 };
      codes.delete(where.email);
      return { count: 1 };
    },
  },
  freeSessionRequest: {
    findUnique: async ({ where }) => trialRequests.get(where.userId),
    create: async ({ data }) => {
      if (failNextTrial) {
        failNextTrial = false;
        throw new Error("Trial write failed");
      }
      if (trialRequests.has(data.userId)) throw Object.assign(new Error("Unique trial owner"), { code: "P2002" });
      const trial = { ...data, id: trialRequests.size + 100 };
      trialRequests.set(data.userId, trial);
      return trial;
    },
  },
  notificationDelivery: {
    create: async ({ data }) => {
      sent.push(data.eventType);
      return { ...data, id: sent.length };
    },
  },
  $transaction: async (work) => {
    const maps = [accounts, codes, trialRequests];
    const snapshots = maps.map((map) => new Map(map));
    try {
      return await work(prisma);
    } catch (error) {
      maps.forEach((map, index) => {
        map.clear();
        for (const [key, value] of snapshots[index]) map.set(key, value);
      });
      throw error;
    }
  },
};
globalThis.prisma = prisma;
const { default: authRoutes } = await import("../../src/routes/auth.js");
const { default: freeSessionRoutes } = await import("../../src/routes/free-session.js");

function addVerification(email, expiresAt = new Date(Date.now() + 60_000)) {
  codes.set(email, { codeHash: hash("123456"), attempts: 0, expiresAt });
}

test("trial signup verifies an email and links account and booking in one transaction", async (t) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = req.get("existing-session") ? session : {};
    next();
  });
  app.use("/api/auth", authRoutes);
  app.use("/api", freeSessionRoutes);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const client = request(server);
  const trial = {
    goal: "interviews",
    availabilitySlots: ["tuesday 19:00"],
    notes: "I need to handle job interviews.",
    locale: "ar",
  };
  const payload = {
    email: "Trial@Example.test",
    code: "123456",
    name: "Trial Learner",
    phone: "+20 10 1234 5678",
    password: "TrialExample123",
    trial,
  };
  const endpoint = "/api/auth/register/complete-trial";
  const existingEndpoint = "/api/free-session-requests/account";
  addVerification("trial@example.test");
  await client.post(endpoint).send({ ...payload, code: "654321" }).expect(400, /INVALID_VERIFICATION_CODE/);
  assert.equal(codes.get("trial@example.test").attempts, 1);
  assert.equal(accounts.size, 0);
  assert.equal(trialRequests.size, 0);

  await client.post(endpoint).send({ ...payload, trial: { ...trial, availabilitySlots: [] } }).expect(400);
  assert.equal(accounts.size, 0);
  assert.equal(codes.size, 1);

  failNextTrial = true;
  await client.post(endpoint).send(payload).expect(500);
  assert.equal(accounts.size, 0);
  assert.equal(trialRequests.size, 0);
  assert.equal(codes.size, 1);

  const registration = await client.post(endpoint).set("existing-session", "yes").send(payload).expect(200);
  assert.equal(registration.body.user.language, "ar");
  assert.equal(registration.body.user.hashedPassword, undefined);
  assert.equal(session.user.email, "trial@example.test");
  assert.equal(session.user.id, registration.body.user.id);
  assert.equal(codes.size, 0);
  assert.equal(await bcrypt.compare(payload.password, accounts.get("trial@example.test").hashedPassword), true);

  const saved = trialRequests.get(session.user.id);
  assert.equal(saved.id, registration.body.requestId);
  assert.equal(saved.email, session.user.email);
  assert.equal(saved.phone, "+201012345678");
  assert.deepEqual(saved.availabilitySlots, trial.availabilitySlots);
  assert.equal(saved.password, undefined);
  assert.equal(saved.code, undefined);

  await client.post(endpoint).send(payload).expect(409, /EMAIL_ALREADY_REGISTERED/);
  const loggedInBody = { ...trial, name: payload.name, phone: payload.phone, email: "different@example.test" };
  await client.post(existingEndpoint).send(loggedInBody).expect(401);
  const repeated = await client.post(existingEndpoint).set("existing-session", "yes").send(loggedInBody).expect(200);
  assert.equal(repeated.body.alreadyRequested, true);
  assert.equal(repeated.body.requestId, saved.id);
  assert.equal(trialRequests.size, 1);

  const standard = { ...payload, email: "regular@example.test" };
  delete standard.trial;
  addVerification(standard.email);
  const regular = await client.post("/api/auth/register/complete").set("existing-session", "yes").send(standard).expect(200);
  assert.equal(regular.body.requestId, undefined);
  assert.equal(trialRequests.size, 1);

  const requested = await client.post(existingEndpoint).set("existing-session", "yes").send({ ...loggedInBody, locale: "en" }).expect(201);
  const secondTrial = trialRequests.get(regular.body.user.id);
  assert.equal(secondTrial.email, standard.email);
  assert.equal(secondTrial.locale, "en");
  assert.equal(requested.body.requestId, secondTrial.id);
  assert.equal(sent.filter((kind) => kind === "free_session_request").length, 2);
});
