// api/index.js

// ─────────────────────────────────────────────────────────────────────────────
// Core: Express app, CORS, sessions, dotenv, axios, mail
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";
import cors from "cors";
import session from "express-session";
import "dotenv/config";
import axios from "axios";
import nodemailer from "nodemailer";
import { OAuth2Client } from "google-auth-library";

// ─────────────────────────────────────────────────────────────────────────────
// Auth & DB: bcrypt for password hashing, Prisma for DB, crypto for code hashing
// ─────────────────────────────────────────────────────────────────────────────
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const app = express();
const prisma = new PrismaClient();
axios.defaults.withCredentials = true;

// define early so it’s safe to use everywhere below
const isProd = process.env.NODE_ENV === "production";

/* ========================================================================== */
/*                         GOOGLE CLIENT ID (Unified)                         */
/*  Use the SAME env var name as the frontend for consistency.                */
/* ========================================================================== */
const GOOGLE_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
  process.env.GOOGLE_CLIENT_ID ||
  "";

if (!GOOGLE_CLIENT_ID) {
  console.warn(
    "⚠️  GOOGLE_CLIENT_ID missing. Set NEXT_PUBLIC_GOOGLE_CLIENT_ID (or GOOGLE_CLIENT_ID) in the backend environment."
  );
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/* ========================================================================== */
/*                             MAILER (shared)                                 */
/*  Build one Nodemailer transporter at startup. Fallback logs emails in dev.  */
/* ========================================================================== */
const EMAIL_FROM =
  process.env.EMAIL_FROM || "Speexify <no-reply@speexify.local>";

const hasSMTP =
  !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;

let transporter = null;
if (hasSMTP) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, // e.g. smtp.sendgrid.net
    port: Number(process.env.SMTP_PORT || 587), // 587 (STARTTLS)
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  // Optional: verify connection once at boot
  transporter
    .verify()
    .then(() => console.log("📧 SMTP transporter ready"))
    .catch((err) => {
      console.warn(
        "⚠️  SMTP verify failed. Falling back to console email.",
        err?.message || err
      );
      transporter = null; // ensure we fall back to console logs
    });
}

/** Send an email (uses transporter if available; else logs to console in dev) */
async function sendEmail(to, subject, html) {
  if (!transporter) {
    console.log(`\n[DEV EMAIL] To: ${to}\nSubject: ${subject}\n${html}\n`);
    return;
  }
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, html });
}

/* ========================================================================== */
/*                               MIDDLEWARE                                   */
/* ========================================================================== */

app.use(express.json());

// trust Render's proxy so 'secure' cookies work properly
app.set("trust proxy", 1);

// Allowlist multiple origins via env variable
// Example: ALLOWED_ORIGINS="http://localhost:3000,https://www.speexify.com,https://speexify-frontend.vercel.app"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim());

const corsOptions = {
  origin(origin, cb) {
    // No Origin header → server-to-server, SSR fetches, curl/Postman, etc.
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true, // <-- required for cookies
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 204, // some browsers expect 204 for preflight
};

// Must be before your routes
app.use(cors(corsOptions));
// Ensure OPTIONS preflight is handled for all routes (use RegExp, not string)
app.options(/.*/, cors(corsOptions));

if (!process.env.SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set. Using an insecure fallback for dev."
  );
}

// If your frontend is speexify.com, use the parent domain so the cookie
// is valid across subdomains (optional but recommended).
const cookieDomain = isProd ? ".speexify.com" : undefined;

app.use(
  session({
    name: "speexify.sid",
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd, // ✅ secure in prod
      sameSite: isProd ? "none" : "lax", // ✅ "none" for cross-site in prod
      domain: cookieDomain, // ✅ optional but recommended
      path: "/", // ✅ be explicit
      maxAge: 1000 * 60 * 60 * 24, // 1 day
    },
  })
);

/* ========================================================================== */
/*                                  HELPERS                                   */
/* ========================================================================== */

// Small utilities for the verification / codes flow
const genCode = () => String(Math.floor(100000 + Math.random() * 900000)); // 6-digit numeric
const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

// For OAuth accounts we don't need a user-chosen password.
// We'll store a random bcrypt hash to satisfy NOT NULL schema.
async function randomHashedPassword() {
  const rand = crypto.randomBytes(32).toString("hex");
  return await bcrypt.hash(rand, 10);
}

// Cents → number of dollars (float) for quick display (admin only UIs)
function centsToDollars(cents) {
  return typeof cents === "number" ? Math.round(cents) / 100 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified “public user” projection + audit helper
// ─────────────────────────────────────────────────────────────────────────────
const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  timezone: true,
  isDisabled: true,
  rateHourlyCents: true,
  ratePerSessionCents: true,
};

/** Minimal audit helper (no-op if Audit model not added yet). */
async function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    await prisma.audit.create({
      data: { actorId, action, entity, entityId, meta },
    });
  } catch {
    /* ignore if table not present yet */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tightened auth guards with “view-as” support
// ─────────────────────────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const sessionUser = req.session.user;
  if (!sessionUser) return res.status(401).json({ error: "Not authenticated" });

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: sessionUser.id },
      select: publicUserSelect,
    });

    if (!dbUser || dbUser.isDisabled) {
      req.session.destroy(() => {});
      return res.status(403).json({ error: "Account disabled" });
    }

    req.user = dbUser; // the admin (or normal) user actually logged in
    req.viewUserId = req.session.asUserId || dbUser.id; // who we’re “viewing as”
    next();
  } catch (e) {
    console.error("requireAuth error:", e);
    return res.status(500).json({ error: "Auth check failed" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  if (req.user.role !== "admin")
    return res.status(403).json({ error: "Admin only" });
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// Session overlap helpers (server-side authoritative validation)
// ─────────────────────────────────────────────────────────────────────────────
function overlapsFilter(startAt, endAt) {
  // If no endAt, treat as open-ended to the far future (or clamp if you prefer)
  const end = endAt ? new Date(endAt) : new Date("2999-12-31");
  return {
    startAt: { lt: end },
    OR: [{ endAt: { gt: new Date(startAt) } }, { endAt: null }],
  };
}

/**
 * Check for conflicts for a learner and/or a teacher.
 * Excludes "canceled" sessions and can exclude a specific sessionId (for edits).
 */
async function findSessionConflicts({
  startAt,
  endAt,
  userId,
  teacherId,
  excludeId,
}) {
  const whereCommon = {
    status: { not: "canceled" },
    ...(excludeId ? { id: { not: excludeId } } : {}),
    AND: [overlapsFilter(startAt, endAt)],
  };

  const clauses = [];
  if (userId) clauses.push({ ...whereCommon, userId });
  if (teacherId) clauses.push({ ...whereCommon, teacherId });

  if (!clauses.length) return [];

  return prisma.session.findMany({
    where: { OR: clauses },
    select: {
      id: true,
      title: true,
      startAt: true,
      endAt: true,
      userId: true,
      teacherId: true,
      status: true,
    },
    orderBy: { startAt: "asc" },
  });
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

// Keep the section header comment you already have
app.get("/api/packages", async (req, res) => {
  try {
    const aud = String(req.query?.audience || "").toUpperCase();
    const where = { active: true };
    if (aud === "INDIVIDUAL" || aud === "CORPORATE") where.audience = aud;

    const packages = await prisma.package.findMany({
      where,
      orderBy: [{ sortOrder: "asc" }, { priceUSD: "asc" }],
      // return everything the frontend might need
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

    // harmonize naming with frontend (it expects "featuresRaw")
    const mapped = packages.map((p) => ({ ...p, featuresRaw: p.features }));
    res.json(mapped);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch packages" });
  }
});

// POST /api/contact  -> emails the team (replace addresses as needed)
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
/*  NOTE: We now *guard* the old one-step register endpoint.                   */
/*        By default, it is DISABLED and returns 410 Gone.                     */
/*        Set ALLOW_LEGACY_REGISTER=true in .env to temporarily re-enable.     */
/* ========================================================================== */

const ALLOW_LEGACY_REGISTER =
  String(process.env.ALLOW_LEGACY_REGISTER || "").toLowerCase() === "true";

if (ALLOW_LEGACY_REGISTER) {
  // ── Legacy register (optional, not recommended) ───────────────────────────
  app.post("/api/auth/register", async (req, res) => {
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

      req.session.asUserId = null; // clear view-as
      req.session.user = user; // start session
      res.json({ user });
    } catch (err) {
      console.error("Register error:", err);
      res.status(500).json({ error: "Failed to register" });
    }
  });
} else {
  // ── Hard stop: force the new verified flow ────────────────────────────────
  app.post("/api/auth/register", (_req, res) => {
    return res.status(410).json({
      error:
        "Registration requires email verification. Use /api/auth/register/start then /api/auth/register/complete.",
    });
  });
}

/* ========================================================================== */
/*                           GOOGLE OAUTH (ID TOKEN)                           */
/*  POST /api/auth/google  { credential }                                      */
/*  - Verify Google ID token (aud=GOOGLE_CLIENT_ID)                            */
/*  - If user exists (by email): sign them in (block if disabled)              */
/*  - Else: create user with random hashed password                            */
/* ========================================================================== */

app.post("/api/auth/google", express.json(), async (req, res) => {
  try {
    // Basic config sanity
    if (!GOOGLE_CLIENT_ID) {
      console.error(
        "[google] Missing GOOGLE_CLIENT_ID env; cannot verify token."
      );
      return res.status(500).json({ ok: false, error: "config_error" });
    }

    // 1) read GIS payload
    const credential =
      typeof req.body?.credential === "string" ? req.body.credential : "";
    if (!credential) {
      return res.status(400).json({ ok: false, error: "missing_credential" });
    }

    // Helpful diagnostics
    const origin = req.get("origin") || "unknown-origin";
    console.log("[google] verify start", {
      origin,
      audience: GOOGLE_CLIENT_ID.slice(0, 10) + "...",
    });

    // 2) verify ID token against your client id
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID, // must match the frontend client id used by @react-oauth/google
    });

    const payload = ticket.getPayload(); // sub, email, name, picture, email_verified, ...
    const email = String(payload?.email || "")
      .toLowerCase()
      .trim();
    const emailVerified = Boolean(payload?.email_verified);
    const name = payload?.name ? String(payload.name).trim() : null;

    if (!email || !emailVerified) {
      return res.status(400).json({ ok: false, error: "unverified_email" });
    }

    // 3) find or create user by email
    let user = await prisma.user.findUnique({ where: { email } });

    if (user?.isDisabled) {
      return res.status(403).json({ ok: false, error: "account_disabled" });
    }

    if (!user) {
      const hashedPassword = await randomHashedPassword();
      user = await prisma.user.create({
        data: { email, name, hashedPassword, role: "learner" },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
        },
      });
    } else {
      // normalize returned shape
      user = await prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
        },
      });
    }

    // 4) establish session (cookie must be SameSite=None; Secure=true in prod session config)
    req.session.asUserId = null; // clear any impersonation
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone ?? null,
    };

    // Ensure session is persisted before responding
    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("[google] session.save error:", saveErr);
        return res.status(500).json({ ok: false, error: "session_error" });
      }
      console.log("[google] verify ok → session established for", email);
      return res.json({ ok: true, user: req.session.user });
    });
  } catch (err) {
    // Distinguish token/audience problems from other errors
    const msg = (err && (err.message || err.toString())) || "unknown_error";
    console.error("[google] verify error:", msg);

    // Common token issues → 401
    const tokenErr = [
      "Wrong number of segments",
      "invalid_token",
      "Token used too late",
      "audience mismatch",
      "Invalid token signature",
      "malformed",
      "expired",
    ].some((s) => msg.toLowerCase().includes(s.toLowerCase()));

    if (tokenErr) {
      return res.status(401).json({ ok: false, error: "invalid_google_token" });
    }

    // Everything else → 500
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ========================================================================== */
/*                          PASSWORD RESET (2-step)                            */
/*  Step 1: /api/auth/password/reset/start     → send 6-digit code            */
/*  Step 2: /api/auth/password/reset/complete  → verify & set new password    */
/* ========================================================================== */

// START: always respond {ok:true} (don’t leak whether an email exists)
app.post("/api/auth/password/reset/start", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.json({ ok: true });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.json({ ok: true });

    const prev = await prisma.passwordResetCode.findUnique({
      where: { email },
    });
    if (prev) {
      const last = new Date(prev.updatedAt).getTime();
      const elapsed = Date.now() - last;
      if (elapsed < 60_000) return res.json({ ok: true }); // silent throttle
    }

    const code = genCode();
    const data = {
      email,
      codeHash: hashCode(code),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      attempts: 0,
    };

    await prisma.passwordResetCode.upsert({
      where: { email },
      update: {
        codeHash: data.codeHash,
        expiresAt: data.expiresAt,
        attempts: 0,
      },
      create: data,
    });

    await sendEmail(
      email,
      "Your Speexify password reset code",
      `<p>Use this code to reset your password:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>This code expires in 10 minutes.</p>`
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("password/reset/start error:", err);
    return res.json({ ok: true });
  }
});

// COMPLETE: verify code & set new password
app.post("/api/auth/password/reset/complete", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const code = String(req.body?.code || "").trim();
    const newPassword = String(req.body?.newPassword || "");

    if (!/^\S+@\S+\.\S+$/.test(email))
      return res.status(400).json({ error: "Valid email is required" });
    if (!/^\d{6}$/.test(code))
      return res.status(400).json({ error: "A 6-digit code is required" });
    if (newPassword.length < 8)
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: "Invalid code" }); // generic

    const pr = await prisma.passwordResetCode.findUnique({ where: { email } });
    if (!pr) return res.status(400).json({ error: "Invalid or expired code" });

    if (new Date() > pr.expiresAt) {
      await prisma.passwordResetCode.delete({ where: { email } });
      return res
        .status(400)
        .json({ error: "Code expired. Request a new one." });
    }
    if (pr.attempts >= 5) {
      await prisma.passwordResetCode.delete({ where: { email } });
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again later." });
    }

    const ok = pr.codeHash === hashCode(code);
    if (!ok) {
      await prisma.passwordResetCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: "Invalid code" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { email }, data: { hashedPassword } });
    await prisma.passwordResetCode.delete({ where: { email } });

    req.session.asUserId = null;
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone ?? null,
    };

    return res.json({ ok: true });
  } catch (err) {
    console.error("password/reset/complete error:", err);
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

/* ========================================================================== */
/*                                   LOGIN                                    */
/* ========================================================================== */

app.post("/api/auth/login", async (req, res) => {
  try {
    let { email, password } = req.body;
    email = (email || "").toLowerCase().trim();
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required" });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.isDisabled)
      return res.status(403).json({ error: "Account disabled" });

    const ok = await bcrypt.compare(password, user.hashedPassword);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const sessionUser = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone ?? null,
    };
    req.session.asUserId = null; // clear view-as
    req.session.user = sessionUser;
    res.json({ user: sessionUser });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Failed to login" });
  }
});

// WHO AM I (session peek) — compatible shape { user: ... }
app.get("/api/auth/me", async (req, res) => {
  // no session → always { user: null }
  if (!req.session.user) return res.json({ user: null });

  const adminUser = await prisma.user.findUnique({
    where: { id: req.session.user.id },
    select: publicUserSelect,
  });

  // disabled / missing → clear and return { user: null }
  if (!adminUser || adminUser.isDisabled) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  // if impersonating, return viewed user + extra flags (but still under `user`)
  if (req.session.asUserId) {
    const asUser = await prisma.user.findUnique({
      where: { id: req.session.asUserId },
      select: publicUserSelect,
    });
    return res.json({
      user: asUser ? { ...asUser, _impersonating: true } : null,
      admin: adminUser, // optional, for banners like “viewing as”
    });
  }

  // normal case
  return res.json({ user: adminUser });
});

// LOGOUT (ensure cookie flags match session config so it clears properly)
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    const cookieDomain = isProd ? ".speexify.com" : undefined;

    res.clearCookie("speexify.sid", {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      domain: cookieDomain,
      path: "/", // must match
    });

    res.json({ ok: true });
  });
});

/* ========================================================================== */
/*                   NEW AUTH: EMAIL VERIFICATION (RECOMMENDED)               */
/*  Step 1: /api/auth/register/start     → send 6-digit code                  */
/*  Step 2: /api/auth/register/complete  → verify code & create account       */
/*  Requires Prisma model: VerificationCode.                                  */
/* ========================================================================== */

app.post("/api/auth/register/start", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    const prev = await prisma.verificationCode.findUnique({ where: { email } });
    if (prev) {
      const last = new Date(prev.updatedAt).getTime();
      const elapsed = Date.now() - last;
      if (elapsed < 60_000) {
        const wait = Math.ceil((60_000 - elapsed) / 1000);
        return res
          .status(429)
          .json({ error: `Please wait ${wait}s before resending` });
      }
    }

    const code = genCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    await prisma.verificationCode.upsert({
      where: { email },
      update: { codeHash, expiresAt, attempts: 0 },
      create: { email, codeHash, expiresAt, attempts: 0 },
    });

    await sendEmail(
      email,
      "Your Speexify verification code",
      `<p>Your verification code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>This code expires in 10 minutes.</p>`
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("register/start error:", err);
    return res.status(500).json({ error: "Failed to start registration" });
  }
});

app.post("/api/auth/register/complete", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "");

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "A 6-digit code is required" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists)
      return res.status(409).json({ error: "Email is already registered" });

    const v = await prisma.verificationCode.findUnique({ where: { email } });
    if (!v)
      return res
        .status(400)
        .json({ error: "No verification code found for this email" });

    if (new Date() > v.expiresAt) {
      await prisma.verificationCode.delete({ where: { email } });
      return res.status(400).json({ error: "Verification code has expired" });
    }

    if (v.attempts >= 5) {
      await prisma.verificationCode.delete({ where: { email } });
      return res
        .status(429)
        .json({ error: "Too many attempts. Request a new code." });
    }

    const isMatch = v.codeHash === hashCode(code);
    if (!isMatch) {
      await prisma.verificationCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: "Invalid verification code" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, name: name || null, hashedPassword, role: "learner" },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        timezone: true,
        isDisabled: true,
      },
    });

    await prisma.verificationCode.delete({ where: { email } });

    req.session.asUserId = null;
    req.session.user = user;

    return res.json({ ok: true, user });
  } catch (err) {
    console.error("register/complete error:", err);
    return res.status(500).json({ error: "Failed to complete registration" });
  }
});

/* ========================================================================== */
/*                              PROFILE (Step 2)                               */
/*  User profile read/update for name/timezone; keeps session in sync.         */
/*  NOTE (Step 2): read/write uses req.viewUserId → works with "view-as".      */
/* ========================================================================== */

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const me = await prisma.user.findUnique({
      where: { id: req.viewUserId }, // ← view-as aware
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
      where: { id: req.viewUserId }, // ← view-as aware
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
/*                                 ADMIN: USERS (Step 3)                      */
/*  Endpoints for:                                                            */
/*   - List users with search                                                 */
/*   - Create user                                                            */
/*   - Change role / enable-disable                                           */
/*   - Send reset-password code                                               */
/*   - Impersonate (start/stop) with audit                                    */
/* ========================================================================== */

app.get(
  "/api/admin/users",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const { q = "", role = "" } = req.query;
      const where = {};
      if (q) {
        where.OR = [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ];
      }
      if (role) where.role = String(role);

      const users = await prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
          createdAt: true,
        },
        orderBy: { id: "asc" },
      });
      res.json(users);
    } catch (err) {
      next(err);
    }
  }
);

// CREATE user (admin invite)
app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    let { email, name = "", role = "learner", timezone = null } = req.body;
    email = String(email || "")
      .toLowerCase()
      .trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: "User already exists" });

    // Create with a random password; they’ll reset via email.
    const rand = crypto.randomBytes(16).toString("hex");
    const hashedPassword = await bcrypt.hash(rand, 10);

    const user = await prisma.user.create({
      data: { email, name: name || null, role, timezone, hashedPassword },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        timezone: true,
        isDisabled: true,
      },
    });

    // Immediately send a reset code so they can set their password
    const code = genCode();
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + 10 * 60_000);

    await prisma.passwordResetCode.upsert({
      where: { email },
      update: { codeHash, expiresAt, attempts: 0 },
      create: { email, codeHash, expiresAt, attempts: 0 },
    });

    await sendEmail(
      email,
      "Welcome to Speexify — set your password",
      `<p>Hi${name ? " " + name : ""},</p>
       <p>Your setup code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>Use it on the “Forgot password” page within 10 minutes.</p>`
    );

    await audit(req.user.id, "user_create", "User", user.id, { email, role });

    res.status(201).json({ user });
  } catch (err) {
    console.error("admin.createUser error:", err);
    res.status(500).json({ error: "Failed to create user" });
  }
});

/* ========================================================================== */
/*                               ADMIN: PACKAGES                              */
/* ========================================================================== */

// GET /api/admin/packages?audience=&q=&active=
// (Add requireAuth before requireAdmin so req.user is present)
app.get("/api/admin/packages", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { audience = "", q = "", active = "" } = req.query;
    const where = {};

    if (audience === "INDIVIDUAL" || audience === "CORPORATE")
      where.audience = audience;
    if (active === "true") where.active = true;
    if (active === "false") where.active = false;

    if (q) {
      where.OR = [
        { title: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { features: { contains: q, mode: "insensitive" } },
      ];
    }

    const items = await prisma.package.findMany({
      where,
      orderBy: [{ audience: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });

    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load packages" });
  }
});

// POST /api/admin/packages
app.post("/api/admin/packages", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      audience = "INDIVIDUAL",
      priceType = "BUNDLE",
      priceUSD = null,
      startingAtUSD = null,
      sessionsPerPack = null,
      durationMin = null,
      isPopular = false,
      active = true,
      sortOrder = 0,
      image = null,
      features = "",
    } = req.body;

    if (!title) return res.status(400).json({ error: "title is required" });
    if (!["INDIVIDUAL", "CORPORATE"].includes(audience))
      return res
        .status(400)
        .json({ error: "audience must be INDIVIDUAL or CORPORATE" });
    if (!["PER_SESSION", "BUNDLE", "CUSTOM"].includes(priceType))
      return res.status(400).json({ error: "priceType invalid" });

    const created = await prisma.package.create({
      data: {
        title,
        description: description || null,
        audience,
        priceType,
        priceUSD: priceUSD !== null ? Number(priceUSD) : null,
        startingAtUSD: startingAtUSD !== null ? Number(startingAtUSD) : null,
        sessionsPerPack:
          sessionsPerPack !== null ? Number(sessionsPerPack) : null,
        durationMin: durationMin !== null ? Number(durationMin) : null,
        isPopular: !!isPopular,
        active: !!active,
        sortOrder: Number(sortOrder || 0),
        image: image || null,
        features: features || "",
      },
    });
    res.status(201).json(created);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create package" });
  }
});

// PATCH /api/admin/packages/:id
app.patch(
  "/api/admin/packages/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const data = {};
      const fields = [
        "title",
        "description",
        "audience",
        "priceType",
        "image",
        "features",
        "isPopular",
        "active",
        "sortOrder",
        "sessionsPerPack",
        "durationMin",
        "priceUSD",
        "startingAtUSD",
      ];
      for (const k of fields) {
        if (req.body[k] !== undefined) data[k] = req.body[k];
      }

      // normalize types
      if (data.priceUSD !== undefined)
        data.priceUSD = data.priceUSD === null ? null : Number(data.priceUSD);
      if (data.startingAtUSD !== undefined)
        data.startingAtUSD =
          data.startingAtUSD === null ? null : Number(data.startingAtUSD);
      if (data.sessionsPerPack !== undefined)
        data.sessionsPerPack =
          data.sessionsPerPack === null ? null : Number(data.sessionsPerPack);
      if (data.durationMin !== undefined)
        data.durationMin =
          data.durationMin === null ? null : Number(data.durationMin);
      if (data.sortOrder !== undefined) data.sortOrder = Number(data.sortOrder);
      if (data.isPopular !== undefined) data.isPopular = !!data.isPopular;
      if (data.active !== undefined) data.active = !!data.active;

      const updated = await prisma.package.update({ where: { id }, data });
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to update package" });
    }
  }
);

// DELETE /api/admin/packages/:id
app.delete(
  "/api/admin/packages/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.package.delete({ where: { id } });
      res.json({ ok: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to delete package" });
    }
  }
);

// PATCH user: role / enable-disable / name / timezone
app.patch(
  "/api/admin/users/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const { role, isDisabled, name, timezone } = req.body;

      const before = await prisma.user.findUnique({
        where: { id },
        select: { id: true, role: true, isDisabled: true },
      });
      if (!before) return res.status(404).json({ error: "Not found" });

      const user = await prisma.user.update({
        where: { id },
        data: {
          ...(role ? { role } : {}),
          ...(typeof isDisabled === "boolean" ? { isDisabled } : {}),
          ...(name !== undefined ? { name } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
        },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          timezone: true,
          isDisabled: true,
        },
      });

      if (role && role !== before.role) {
        await audit(req.user.id, "role_change", "User", id, {
          from: before.role,
          to: role,
        });
      }
      if (typeof isDisabled === "boolean" && isDisabled !== before.isDisabled) {
        await audit(
          req.user.id,
          isDisabled ? "user_disable" : "user_enable",
          "User",
          id
        );
      }

      res.json(user);
    } catch (err) {
      console.error("admin.patchUser error:", err);
      res.status(500).json({ error: "Failed to update user" });
    }
  }
);

// Send password-reset code to a user (admin-triggered)
app.post(
  "/api/admin/users/:id/reset-password",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) return res.status(404).json({ error: "Not found" });

      const code = genCode();
      const codeHash = hashCode(code);
      const expiresAt = new Date(Date.now() + 10 * 60_000);

      await prisma.passwordResetCode.upsert({
        where: { email: user.email },
        update: { codeHash, expiresAt, attempts: 0 },
        create: { email: user.email, codeHash, expiresAt, attempts: 0 },
      });

      await sendEmail(
        user.email,
        "Reset your Speexify password",
        `<p>Hi ${user.name || ""}</p>
       <p>Your reset code is:</p>
       <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
       <p>Use it on the “Forgot password” page within 10 minutes.</p>`
      );

      await audit(req.user.id, "password_reset_send", "User", id);
      res.json({ ok: true });
    } catch (err) {
      console.error("admin.resetPassword error:", err);
      res.status(500).json({ error: "Failed to send reset" });
    }
  }
);

// IMPERSONATE (start/stop)
app.post(
  "/api/admin/impersonate/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (targetId === req.user.id)
        return res.status(400).json({ error: "Cannot impersonate yourself" });

      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, isDisabled: true },
      });
      if (!target || target.isDisabled)
        return res.status(404).json({ error: "Target not available" });

      req.session.asUserId = targetId; // mark “view as”
      await audit(req.user.id, "impersonate_start", "User", targetId);
      res.json({ ok: true });
    } catch (err) {
      console.error("admin.impersonateStart error:", err);
      res.status(500).json({ error: "Failed to impersonate" });
    }
  }
);

app.post(
  "/api/admin/impersonate/stop",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      if (req.session.asUserId) {
        await audit(
          req.user.id,
          "impersonate_stop",
          "User",
          req.session.asUserId
        );
      }
      req.session.asUserId = null;
      res.json({ ok: true });
    } catch (err) {
      console.error("admin.impersonateStop error:", err);
      res.status(500).json({ error: "Failed to stop impersonation" });
    }
  }
);

// PATCH teacher rates (cents). Body: { rateHourlyCents?, ratePerSessionCents? }
app.patch(
  "/api/admin/teachers/:id/rates",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    const { rateHourlyCents, ratePerSessionCents } = req.body;

    const teacher = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!teacher) return res.status(404).json({ error: "Not found" });
    if (teacher.role !== "teacher")
      return res.status(400).json({ error: "User is not a teacher" });

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(rateHourlyCents !== undefined
          ? { rateHourlyCents: Number(rateHourlyCents) || 0 }
          : {}),
        ...(ratePerSessionCents !== undefined
          ? { ratePerSessionCents: Number(ratePerSessionCents) || 0 }
          : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        rateHourlyCents: true,
        ratePerSessionCents: true,
      },
    });

    await audit(req.user.id, "teacher_rates_update", "User", id, {
      rateHourlyCents: updated.rateHourlyCents,
      ratePerSessionCents: updated.ratePerSessionCents,
    });

    res.json(updated);
  }
);

/* ========================================================================== */
/*                             SESSIONS (LESSONS)                              */
/* ========================================================================== */

// Check conflicts for a proposed time range
// GET /api/sessions/conflicts?start=ISO&end=ISO&userId=&teacherId=&excludeId=
app.get("/api/sessions/conflicts", requireAuth, async (req, res) => {
  const startParam = String(req.query.start || "");
  const endParam = req.query.end ? String(req.query.end) : null;

  const startAt = new Date(startParam);
  const endAt = endParam ? new Date(endParam) : null;

  if (Number.isNaN(startAt.getTime())) {
    return res.status(400).json({ error: "start is required (ISO datetime)" });
  }
  if (endParam && Number.isNaN(endAt.getTime())) {
    return res.status(400).json({ error: "end must be a valid ISO datetime" });
  }

  const userId = req.query.userId ? Number(req.query.userId) : null;
  const teacherId = req.query.teacherId ? Number(req.query.teacherId) : null;
  const excludeId = req.query.excludeId
    ? Number(req.query.excludeId)
    : undefined;

  try {
    const conflicts = await findSessionConflicts({
      startAt,
      endAt,
      userId,
      teacherId,
      excludeId,
    });
    res.json({ conflicts });
  } catch (e) {
    console.error("conflicts endpoint error:", e);
    res.status(500).json({ error: "Failed to check conflicts" });
  }
});

// List sessions for the *viewed* user (admin can “view as”)
app.get("/api/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.viewUserId }, // ← view-as aware
      include: {
        teacher: { select: { id: true, name: true, email: true } }, // 👈 include teacher
      },
      orderBy: { startAt: "asc" },
    });
    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// Teacher: sessions assigned to me (view-as aware)
app.get("/api/teacher/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { teacherId: req.viewUserId },
      include: {
        user: { select: { id: true, email: true, name: true } }, // learner
      },
      orderBy: { startAt: "asc" },
    });
    res.json(sessions);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to load teacher sessions" });
  }
});

/* ========================================================================== */
/*                          TEACHER SUMMARY (next)                            */
/*  GET /api/teacher/summary                                                  */
/*  Returns the next upcoming session this teacher will teach, plus counts.   */
/* ========================================================================== */
app.get("/api/teacher/summary", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const now = new Date();

    // counts (exclude canceled)
    const upcomingCount = await prisma.session.count({
      where: {
        teacherId: userId,
        status: { not: "canceled" },
        startAt: { gte: now },
      },
    });

    const completedCount = await prisma.session.count({
      where: {
        teacherId: userId,
        status: "completed",
      },
    });

    // next session should be future OR currently live, and not canceled
    const nextSession = await prisma.session.findFirst({
      where: {
        teacherId: userId,
        status: { not: "canceled" },
        OR: [
          { startAt: { gte: now } }, // future
          {
            AND: [
              { startAt: { lte: now } }, // started
              { OR: [{ endAt: { gte: now } }, { endAt: null }] }, // still live
            ],
          },
        ],
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
        status: true,
      },
    });

    // include timezone if you store it on user
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });

    res.json({
      nextSession,
      upcomingCount,
      completedCount,
      timezone: user?.timezone || null,
    });
  } catch (e) {
    console.error("GET /api/teacher/summary failed:", e);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

/* ========================================================================== */
/*                              LEARNER SUMMARY                                */
/*  NOTE (Step 2): uses req.viewUserId so it works while “viewing as”.         */
/* ========================================================================== */

app.get("/api/me/summary", requireAuth, async (req, res) => {
  const now = new Date();

  try {
    const nextSession = await prisma.session.findFirst({
      where: { userId: req.viewUserId, startAt: { gt: now } }, // ← view-as aware
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
      },
    });

    const upcomingCount = await prisma.session.count({
      where: { userId: req.viewUserId, startAt: { gt: now } },
    });

    const completedCount = await prisma.session.count({
      where: {
        userId: req.viewUserId,
        OR: [
          { endAt: { lt: now } },
          { AND: [{ endAt: null }, { startAt: { lt: now } }] },
        ],
      },
    });

    res.json({ nextSession, upcomingCount, completedCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load summary" });
  }
});

// ============================================================================
// Sessions (Learner)
// ============================================================================

// GET /api/me/sessions?range=upcoming|past&limit=10
app.get("/api/me/sessions", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { range = "upcoming", limit = 10 } = req.query;
    const now = new Date();

    // Include sessions the user attends (userId) and, if teacher, sessions they teach (teacherId)
    const whereBase =
      role === "teacher"
        ? { OR: [{ userId }, { teacherId: userId }] }
        : { userId };

    // Don’t hide pre-migration NULL statuses; just exclude explicit canceled
    const notCanceled = { NOT: { status: "canceled" } };

    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    const where =
      range === "past"
        ? {
            AND: [
              whereBase,
              {
                OR: [
                  { endAt: { lt: now } },
                  { AND: [{ endAt: null }, { startAt: { lt: twoHoursAgo } }] },
                ],
              },
            ],
          }
        : {
            AND: [
              whereBase,
              notCanceled,
              {
                OR: [
                  { startAt: { gte: now } }, // future
                  {
                    AND: [
                      { startAt: { lte: now } }, // started already
                      { OR: [{ endAt: { gte: now } }, { endAt: null }] }, // still ongoing (or no end yet)
                    ],
                  },
                ],
              },
            ],
          };

    const orderBy = range === "past" ? { startAt: "desc" } : { startAt: "asc" };

    const sessions = await prisma.session.findMany({
      where,
      orderBy,
      take: Number(limit) || 10,
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
        status: true,
        feedbackScore: true,
      },
    });

    res.json(sessions);
  } catch (e) {
    console.error("GET /api/me/sessions failed:", e);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// GET /api/me/sessions-between?start=ISO&end=ISO
// Returns sessions overlapping the visible calendar range, excluding canceled.
app.get("/api/me/sessions-between", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { start, end } = req.query;
    const includeCanceled = String(req.query.includeCanceled) === "true";

    // visible window (calendar range)
    const startAt = start ? new Date(start) : new Date("1970-01-01");
    const endAt = end ? new Date(end) : new Date("2999-12-31");

    // learner sees their sessions; teacher also sees ones they teach
    const whereBase =
      role === "teacher"
        ? { OR: [{ userId }, { teacherId: userId }] }
        : { userId };

    const sessions = await prisma.session.findMany({
      where: {
        AND: [
          whereBase,
          includeCanceled ? {} : { status: { not: "canceled" } },
          { startAt: { lte: endAt } },
          { OR: [{ endAt: { gte: startAt } }, { endAt: null }] },
        ],
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
        status: true,
      },
    });

    res.json(sessions);
  } catch (e) {
    console.error("GET /api/me/sessions-between failed:", e);
    res.status(500).json({ error: "Failed to load calendar sessions" });
  }
});

// Sessions: POST /api/sessions/:id/cancel
app.post("/api/sessions/:id/cancel", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);

    // Fetch the session first
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Authorization (owner/teacher/admin):
    const isOwner = session.userId === req.user.id;
    const isTeacher = session.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";

    if (!(isOwner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const updated = await prisma.session.update({
      where: { id },
      data: { status: "canceled" },
    });

    res.json({ ok: true, session: updated });
  } catch (e) {
    console.error("Cancel failed:", e);
    res.status(400).json({ error: "Failed to cancel session" });
  }
});

// Sessions: POST /api/sessions/:id/reschedule  { startAt, endAt }
app.post("/api/sessions/:id/reschedule", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { startAt, endAt } = req.body;

    if (!startAt) return res.status(400).json({ error: "startAt is required" });

    const s = await prisma.session.findUnique({
      where: { id },
      select: { id: true, userId: true, teacherId: true, status: true },
    });
    if (!s) return res.status(404).json({ error: "Not found" });

    // Authorization: owner, assigned teacher, or admin
    const isOwner = s.userId === req.user.id;
    const isTeacher = s.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isOwner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Conflict check (exclude the same session)
    const conflicts = await findSessionConflicts({
      startAt: new Date(startAt),
      endAt: endAt ? new Date(endAt) : null,
      userId: s.userId,
      teacherId: s.teacherId,
      excludeId: id,
    });
    if (conflicts.length) {
      return res.status(409).json({ error: "Time conflict", conflicts });
    }

    const updated = await prisma.session.update({
      where: { id },
      data: {
        startAt: new Date(startAt),
        endAt: endAt ? new Date(endAt) : null,
        status: "scheduled",
      },
    });

    res.json({ ok: true, session: updated });
  } catch (e) {
    console.error("reschedule error:", e);
    res.status(400).json({ error: "Failed to reschedule session" });
  }
});

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

// Teachers list (active + disabled, filterable by ?active=1)
// GET /api/teachers?active=1
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

// Change password (logged-in user ONLY; not affected by view-as)
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
      where: { id: req.user.id }, // ← always your own password
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

// a health route (nice for checks):
app.get("/health", (_req, res) => res.send("ok"));

// check the db
app.get("/api/db-check", async (_req, res) => {
  try {
    const ok = await prisma.$queryRaw`select 1 as ok`;
    res.json(ok);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB not reachable" });
  }
});

// Friendly error handler (turns CORS errors into 403 instead of 500)
app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    console.warn("CORS blocked:", req.headers.origin);
    return res.status(403).json({ error: "Origin not allowed" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

/* ========================================================================== */
/*                                  SERVER                                    */
/* ========================================================================== */

const PORT = process.env.PORT ? Number(process.env.PORT) : 5050;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server is running on http://0.0.0.0:${PORT}`);
});
