// tests/auth.test.js
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import app from "../src/app.js";

const prisma = new PrismaClient();

test("login and /api/auth/me flow works", async (t) => {
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
