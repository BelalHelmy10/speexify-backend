// api/index.js

// ─────────────────────────────────────────────────────────────────────────────
// Core: Express app, CORS, sessions, dotenv, axios, mail
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";
import { initSentry } from "./config/sentry.js";
import * as Sentry from "@sentry/node";
import "dotenv/config";
import axios from "axios";
import { z } from "zod";
import helmet from "helmet";

// ─────────────────────────────────────────────────────────────────────────────
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import {
  isProd,
  PAYMOB_API_KEY,
  PAYMOB_INTEGRATION_ID,
  PAYMOB_IFRAME_ID,
  PAYMOB_HMAC_SECRET,
  ALLOWED_ORIGINS,
  SESSION_SECRET,
  COOKIE_DOMAIN,
} from "./config/env.js";
import { corsMiddleware } from "./middleware/cors.js";
import { sessionMiddleware } from "./middleware/session.js";
import authRoutes from "./routes/auth.js";
import paymentsRoutes from "./routes/payments.js";
import sessionsRoutes from "./routes/sessions.js";
import packagesRoutes from "./routes/packages.js";
import adminRoutes from "./routes/admin.js";
import onboardingAssessmentRoutes from "./routes/onboarding-assessment.js";
import {
  overlapsFilter,
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCredit,
  refundOneCredit,
  finalizeExpiredSessionsForUser,
  finalizeExpiredSessionsForTeacher,
} from "./services/sessionsService.js";
import { sendEmail } from "./services/emailService.js";
import { requireAuth, requireAdmin } from "./middleware/auth-helpers.js";
import { csrfMiddleware, csrfErrorHandler } from "./middleware/csrf.js";
import { logger } from "./lib/logger.js"; // adjust relative path if needed

const app = express();

// Initialize Sentry BEFORE other middlewares
initSentry(app);

const prisma = new PrismaClient();
axios.defaults.withCredentials = true;

// Base URL for Paymob APIs
const PAYMOB_BASE = "https://accept.paymob.com/api";

if (
  !PAYMOB_API_KEY ||
  !PAYMOB_INTEGRATION_ID ||
  !PAYMOB_IFRAME_ID ||
  !PAYMOB_HMAC_SECRET
) {
  console.warn(
    "⚠️  Missing one or more Paymob env vars (PAYMOB_API_KEY, PAYMOB_INTEGRATION_ID, PAYMOB_IFRAME_ID, PAYMOB_HMAC_SECRET). Test mode will fail until set."
  );
}

/* ========================================================================== */
/*                               MIDDLEWARE                                   */
/* ========================================================================== */

app.use(express.json());
app.set("trust proxy", 1);
app.use(helmet());
app.use(corsMiddleware);
app.options(/.*/, corsMiddleware);
app.use(sessionMiddleware);

// CSRF protection for all /api routes (except the ones we skip inside the middleware)
app.use("/api", csrfMiddleware);

// Endpoint to fetch a CSRF token (frontend will call this)
app.get("/api/csrf-token", (req, res) => {
  return res.json({ csrfToken: req.csrfToken() });
});

//mounting the auth
app.use("/api/auth", authRoutes);

//mounting the payment
app.use("/api/payments", paymentsRoutes);

//mounting sessions
app.use("/api", sessionsRoutes);

//mounting packages
app.use("/api", packagesRoutes);

//mounting admin routes
app.use("/api", adminRoutes);

//mounting onboarding and assessment
app.use("/api", onboardingAssessmentRoutes);
/* ========================================================================== */
/*                                  HELPERS                                   */
/* ========================================================================== */

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

async function randomHashedPassword() {
  const rand = crypto.randomBytes(32).toString("hex");
  return await bcrypt.hash(rand, 10);
}

function centsToDollars(cents) {
  return typeof cents === "number" ? Math.round(cents) / 100 : 0;
}

/* ========================================================================== */
/*                              HEALTH / HELLO                                */
/* ========================================================================== */

app.get("/", (_req, res) => res.send("Hello from Speexify API 🚀"));
app.get("/api/message", (_req, res) =>
  res.json({ message: "Hello from the backend 👋" })
);

/* ========================================================================== */
/*                             PUBLIC: PACKAGES                                */
/* ========================================================================== */

app.get("/api/packages", async (req, res) => {
  try {
    const aud = String(req.query?.audience || "").toUpperCase();
    const where = { active: true };
    if (aud === "INDIVIDUAL" || aud === "CORPORATE") where.audience = aud;

    const packages = await prisma.package.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { priceUSD: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        priceUSD: true,
        startingAtUSD: true,
        priceType: true,
        audience: true,
        isPopular: true,
        active: true,
        sortOrder: true,
        sessionsPerPack: true,
        durationMin: true,
        image: true,
        features: true,
      },
    });

    const mapped = packages.map((p) => ({ ...p, featuresRaw: p.features }));
    res.json(mapped);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch packages" });
  }
});

app.post("/api/contact", async (req, res) => {
  const { name, email, company, phone, role, topic, budget, message } =
    req.body || {};
  if (!name || !email || !message)
    return res.status(400).json({ error: "Missing required fields" });

  const html = `
    <h2>New contact form message</h2>
    <p><b>Name:</b> ${name}</p>
    <p><b>Email:</b> ${email}</p>
    <p><b>Company:</b> ${company || "-"}</p>
    <p><b>Phone:</b> ${phone || "-"}</p>
    <p><b>Role:</b> ${role || "-"}</p>
    <p><b>Topic:</b> ${topic || "-"}</p>
    <p><b>Budget:</b> ${budget || "-"}</p>
    <hr/>
    <pre style="font: inherit; white-space: pre-wrap;">${message}</pre>
  `;

  try {
    await sendEmail("hello@speexify.com", `[Contact] ${topic} — ${name}`, html);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to send" });
  }
});

/* ========================================================================== */
/*                       AUTH: EMAIL/PASSWORD (LEGACY)                        */
/* ========================================================================== */

const ALLOW_LEGACY_REGISTER =
  String(process.env.ALLOW_LEGACY_REGISTER || "").toLowerCase() === "true";

if (ALLOW_LEGACY_REGISTER) {
  app.post("/auth/register", async (req, res) => {
    try {
      let { email, password, name } = req.body;
      email = (email || "").toLowerCase().trim();
      if (!email || !password)
        return res
          .status(400)
          .json({ error: "Email and password are required" });

      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing)
        return res.status(409).json({ error: "Email already registered" });

      const hashedPassword = await bcrypt.hash(password, 10);
      const user = await prisma.user.create({
        data: { email, name: name || null, hashedPassword, role: "learner" },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
        },
      });

      req.session.asUserId = null;
      req.session.user = user;
      res.json({ user });
    } catch (err) {
      console.error("Register error:", err);
      res.status(500).json({ error: "Failed to register" });
    }
  });
} else {
  app.post("/api/auth/register", (_req, res) => {
    return res.status(410).json({
      error:
        "Registration requires email verification. Use /api/auth/register/start then /api/auth/register/complete.",
    });
  });
}

/* ========================================================================== */
/*                          PASSWORD RESET (2-step)                            */
/* ========================================================================== */

/* ========================================================================== */
/*                                   LOGIN                                    */
/* ========================================================================== */

/* ========================================================================== */
/*                   NEW AUTH: EMAIL VERIFICATION (RECOMMENDED)               */
/* ========================================================================== */

/* ========================================================================== */
/*                              PROFILE (Step 2)                               */
/* ========================================================================== */

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.viewUserId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        timezone: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json(me);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

app.patch("/api/me", requireAuth, async (req, res) => {
  try {
    const { name, timezone } = req.body;
    const updated = await prisma.user.update({
      where: { id: req.viewUserId },
      data: { name: name?.trim() || null, timezone: timezone || null },
      select: { id: true, email: true, name: true, role: true, timezone: true },
    });

    if (req.viewUserId === req.user.id) {
      req.session.user = {
        ...req.session.user,
        name: updated.name,
        timezone: updated.timezone,
      };
    }

    res.json(updated);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to update profile" });
  }
});

/* ========================================================================== */
/*                        ADMIN: ONBOARDING + ASSESSMENTS                      */
/* ========================================================================== */

/* ========================================================================== */
/*                          TEACHER SUMMARY (next)                            */
/* ========================================================================== */
app.get("/api/teacher/summary", requireAuth, async (req, res) => {
  try {
    await finalizeExpiredSessionsForTeacher(req.viewUserId);
    const userId = req.viewUserId;
    const now = new Date();

    const whereBase = { teacherId: userId };
    const notCanceled = { status: { not: "canceled" } };

    const inProgressOrFuture = {
      OR: [
        { startAt: { gte: now } },
        {
          AND: [
            { startAt: { lte: now } },
            { OR: [{ endAt: { gte: now } }, { endAt: null }] },
          ],
        },
      ],
    };

    const upcomingTeachCount = await prisma.session.count({
      where: { AND: [whereBase, notCanceled, inProgressOrFuture] },
    });

    const taughtCount = await prisma.session.count({
      where: { AND: [whereBase, { status: "completed" }] },
    });

    const nextTeach = await prisma.session.findFirst({
      where: { AND: [whereBase, notCanceled, inProgressOrFuture] },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        joinUrl: true,
        status: true,
      },
    });

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });

    res.json({
      nextTeach,
      upcomingTeachCount,
      taughtCount,
      timezone: user?.timezone || null,
    });
  } catch (e) {
    console.error("GET /api/teacher/summary failed:", e);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

/* ========================================================================== */
/*                              LEARNER SUMMARY                                */
/* ========================================================================== */

app.get("/api/me/summary", requireAuth, async (req, res) => {
  const now = new Date();

  try {
    // Make sure any ended sessions are marked completed and credits consumed
    await finalizeExpiredSessionsForUser(req.viewUserId);

    const role = req.user.role || "learner";
    const whereBase =
      role === "teacher"
        ? { OR: [{ userId: req.viewUserId }, { teacherId: req.viewUserId }] }
        : { userId: req.viewUserId };

    // "Upcoming" should include FUTURE and IN-PROGRESS, exclude canceled
    const inProgressOrFuture = {
      OR: [
        { startAt: { gte: now } }, // future
        {
          AND: [
            { startAt: { lte: now } }, // started
            { OR: [{ endAt: { gte: now } }, { endAt: null }] }, // not ended
          ],
        },
      ],
    };

    const upcomingCount = await prisma.session.count({
      where: {
        ...whereBase,
        status: { not: "canceled" },
        ...inProgressOrFuture,
      },
    });

    // "Completed" strictly by status
    const completedCount = await prisma.session.count({
      where: { ...whereBase, status: "completed" },
    });

    // The UI can compute total = upcoming + completed
    // (or you can return it here as well)
    res.json({ nextSession: null, upcomingCount, completedCount });
  } catch (err) {
    console.error("GET /api/me/summary failed:", err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

// --------------------------------------------------------------------------
// Learner: My packages (entitlements)
// GET /api/me/packages
// Returns an array of entitlements with a computed `remaining` field.
// --------------------------------------------------------------------------
app.get("/api/me/packages", requireAuth, async (req, res) => {
  try {
    const rows = await prisma.userPackage.findMany({
      where: { userId: req.viewUserId },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        minutesPerSession: true,
        sessionsTotal: true,
        sessionsUsed: true,
        expiresAt: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const now = Date.now();
    const items = rows.map((r) => {
      const remaining = Math.max(
        0,
        Number(r.sessionsTotal) - Number(r.sessionsUsed || 0)
      );
      const expired = r.expiresAt
        ? new Date(r.expiresAt).getTime() < now
        : false;
      return {
        ...r,
        remaining,
        expired,
      };
    });

    res.json(items);
  } catch (e) {
    console.error("GET /api/me/packages failed:", e);
    res.status(500).json({ error: "Failed to load packages" });
  }
});

// ============================================================================
// Sessions (Learner)
// ============================================================================

/* ========================================================================== */
/*                                  USERS                                     */
/* ========================================================================== */

app.get("/api/users", requireAuth, async (req, res) => {
  const where = req.query.role ? { role: String(req.query.role) } : undefined;
  const users = await prisma.user.findMany({
    where,
    select: { id: true, email: true, name: true, role: true, timezone: true },
    orderBy: { email: "asc" },
  });
  res.json(users);
});

app.get("/api/teachers", requireAuth, async (req, res) => {
  const onlyActive = String(req.query.active || "") === "1";
  const where = { role: "teacher" };
  if (onlyActive) where.isDisabled = false;

  const teachers = await prisma.user.findMany({
    where,
    select: {
      id: true,
      email: true,
      name: true,
      isDisabled: true,
      rateHourlyCents: true,
      ratePerSessionCents: true,
    },
    orderBy: [{ isDisabled: "asc" }, { email: "asc" }],
  });
  res.json(teachers);
});

app.post("/api/me/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Both passwords are required" });
    }
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters" });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, hashedPassword: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });

    const ok = await bcrypt.compare(currentPassword, user.hashedPassword);
    if (!ok)
      return res.status(401).json({ error: "Current password is incorrect" });

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { hashedPassword },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Failed to change password" });
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/db-check", async (_req, res) => {
  try {
    const ok = await prisma.$queryRaw`select 1 as ok`;
    res.json(ok);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB not reachable" });
  }
});

// CSRF-specific error handler
app.use(csrfErrorHandler);

// Generic error handler (must be last)
app.use((err, req, res, next) => {
  logger.error(
    {
      err,
      path: req.path,
      method: req.method,
      userId: req.session?.user?.id || null,
    },
    "Unhandled error in request"
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({ error: "Internal server error" });
});

export default app;
