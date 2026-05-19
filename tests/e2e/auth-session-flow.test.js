import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { prisma } from "../../src/lib/prisma.js";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import app from "../../src/app.js";

const e2eTest = process.env.RUN_E2E === "1" ? test : test.skip;

e2eTest("login and /api/auth/me flow works", async (t) => {
  const email = `testuser+${Date.now()}@example.com`;
  const plainPassword = "Password123"; // matches our policy: 8+ chars, letters+numbers

  // 1) Create a user directly in the DB
  const hashedPassword = await bcrypt.hash(plainPassword, 10);

  await prisma.user.create({
    data: {
      email,
      hashedPassword,
      role: "learner",
    },
  });

  // Make sure we clean up after the test
  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  // 2) Use supertest's agent to keep cookies between requests
  const agent = request.agent(app);

  // Login
  const loginRes = await agent
    .post("/api/auth/login")
    .send({ email, password: plainPassword });

  assert.equal(loginRes.statusCode, 200);
  assert.ok(loginRes.body.user, "login should return a user");
  assert.equal(loginRes.body.user.email, email);

  // 3) Call /api/auth/me with the same agent (session cookie attached)
  const meRes = await agent.get("/api/auth/me");

  assert.equal(meRes.statusCode, 200);
  assert.ok(meRes.body.user, "/api/auth/me should return a user");
  assert.equal(meRes.body.user.email, email);
});

e2eTest("password change invalidates other active sessions", async (t) => {
  const email = `password-change+${Date.now()}@example.com`;
  const oldPassword = "Password123";
  const newPassword = "Password456";
  const hashedPassword = await bcrypt.hash(oldPassword, 10);

  await prisma.user.create({
    data: {
      email,
      hashedPassword,
      role: "learner",
    },
  });

  t.after(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  const currentAgent = request.agent(app);
  const staleAgent = request.agent(app);

  const currentLogin = await currentAgent
    .post("/api/auth/login")
    .send({ email, password: oldPassword });
  const staleLogin = await staleAgent
    .post("/api/auth/login")
    .send({ email, password: oldPassword });

  assert.equal(currentLogin.statusCode, 200);
  assert.equal(staleLogin.statusCode, 200);

  const changeRes = await currentAgent
    .post("/api/me/password")
    .send({ currentPassword: oldPassword, newPassword });

  assert.equal(changeRes.statusCode, 200);
  assert.deepEqual(changeRes.body, { ok: true });

  const currentMe = await currentAgent.get("/api/auth/me");
  assert.equal(currentMe.statusCode, 200);
  assert.equal(currentMe.body.user.email, email);

  const staleMe = await staleAgent.get("/api/auth/me");
  assert.equal(staleMe.statusCode, 401);
  assert.deepEqual(staleMe.body, {
    error: "Session expired, please log in again",
  });

  const oldPasswordLogin = await request(app)
    .post("/api/auth/login")
    .send({ email, password: oldPassword });
  assert.equal(oldPasswordLogin.statusCode, 401);

  const newPasswordLogin = await request(app)
    .post("/api/auth/login")
    .send({ email, password: newPassword });
  assert.equal(newPasswordLogin.statusCode, 200);
});

e2eTest("password reset invalidates older sessions and keeps reset session active", async (t) => {
  const email = `password-reset+${Date.now()}@example.com`;
  const oldPassword = "Password123";
  const newPassword = "Password456";
  const resetCode = "123456";
  const hashedPassword = await bcrypt.hash(oldPassword, 10);
  const codeHash = crypto
    .createHash("sha256")
    .update(resetCode)
    .digest("hex");

  await prisma.user.create({
    data: {
      email,
      hashedPassword,
      role: "learner",
    },
  });
  await prisma.passwordResetCode.create({
    data: {
      email,
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      attempts: 0,
    },
  });

  t.after(async () => {
    await prisma.passwordResetCode.deleteMany({ where: { email } });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.$disconnect();
  });

  const staleAgent = request.agent(app);
  const resetAgent = request.agent(app);

  const staleLogin = await staleAgent
    .post("/api/auth/login")
    .send({ email, password: oldPassword });
  assert.equal(staleLogin.statusCode, 200);

  const resetRes = await resetAgent
    .post("/api/auth/password/reset/complete")
    .send({ email, code: resetCode, newPassword });

  assert.equal(resetRes.statusCode, 200);
  assert.deepEqual(resetRes.body, { ok: true });

  const resetMe = await resetAgent.get("/api/auth/me");
  assert.equal(resetMe.statusCode, 200);
  assert.equal(resetMe.body.user.email, email);

  const staleMe = await staleAgent.get("/api/auth/me");
  assert.equal(staleMe.statusCode, 401);
  assert.deepEqual(staleMe.body, {
    error: "Session expired, please log in again",
  });

  const updated = await prisma.user.findUnique({
    where: { email },
    select: { passwordChangedAt: true },
  });
  assert.ok(updated.passwordChangedAt);
});
