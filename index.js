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
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

const app = express();
const prisma = new PrismaClient();
axios.defaults.withCredentials = true;

const isProd = process.env.NODE_ENV === "production";

/* ========================================================================== */
/*                         GOOGLE CLIENT ID (Unified)                         */
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
/* ========================================================================== */
const EMAIL_FROM =
  process.env.EMAIL_FROM || "Speexify <no-reply@speexify.local>";

const hasSMTP =
  !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;

let transporter = null;
if (hasSMTP) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });

  transporter
    .verify()
    .then(() => console.log("📧 SMTP transporter ready"))
    .catch((err) => {
      console.warn(
        "⚠️  SMTP verify failed. Falling back to console email.",
        err?.message || err
      );
      transporter = null;
    });
}

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
app.set("trust proxy", 1);

// ALLOWED_ORIGINS="http://localhost:3000,https://www.speexify.com,https://speexify-frontend.vercel.app"
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim());

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

if (!process.env.SESSION_SECRET) {
  console.warn(
    "⚠️  SESSION_SECRET is not set. Using an insecure fallback for dev."
  );
}

const cookieDomain = process.env.COOKIE_DOMAIN || undefined;
console.log("Session cookie domain:", cookieDomain ?? "(host-only)");

app.use(
  session({
    name: "speexify.sid",
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      domain: cookieDomain,
      path: "/",
      maxAge: 1000 * 60 * 60 * 24,
    },
  })
);

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

async function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    await prisma.audit.create({
      data: { actorId, action, entity, entityId, meta },
    });
  } catch {}
}

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

    req.user = dbUser;
    req.viewUserId = req.session.asUserId || dbUser.id;
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

function overlapsFilter(startAt, endAt) {
  const end = endAt ? new Date(endAt) : new Date("2999-12-31");
  return {
    startAt: { lt: end },
    OR: [{ endAt: { gt: new Date(startAt) } }, { endAt: null }],
  };
}

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
/*                           GOOGLE OAUTH (ID TOKEN)                           */
/* ========================================================================== */

app.post("/api/auth/google", express.json(), async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) {
      console.error(
        "[google] Missing GOOGLE_CLIENT_ID env; cannot verify token."
      );
      return res.status(500).json({ ok: false, error: "config_error" });
    }

    const credential =
      typeof req.body?.credential === "string" ? req.body.credential : "";
    if (!credential) {
      return res.status(400).json({ ok: false, error: "missing_credential" });
    }

    const origin = req.get("origin") || "unknown-origin";
    console.log("[google] verify start", {
      origin,
      audience: GOOGLE_CLIENT_ID.slice(0, 10) + "...",
    });

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const email = String(payload?.email || "")
      .toLowerCase()
      .trim();
    const emailVerified = Boolean(payload?.email_verified);
    const name = payload?.name ? String(payload.name).trim() : null;

    if (!email || !emailVerified) {
      return res.status(400).json({ ok: false, error: "unverified_email" });
    }

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

    req.session.asUserId = null;
    req.session.user = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      timezone: user.timezone ?? null,
    };

    req.session.save((saveErr) => {
      if (saveErr) {
        console.error("[google] session.save error:", saveErr);
        return res.status(500).json({ ok: false, error: "session_error" });
      }
      res.set({
        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Surrogate-Control": "no-store",
        Vary: "Cookie",
      });
      console.log("[google] verify ok → session established for", email);
      return res.json({ ok: true, user: req.session.user });
    });
  } catch (err) {
    const msg = (err && (err.message || err.toString())) || "unknown_error";
    console.error("[google] verify error:", msg);

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
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

/* ========================================================================== */
/*                          PASSWORD RESET (2-step)                            */
/* ========================================================================== */

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
      if (elapsed < 60_000) return res.json({ ok: true });
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
    if (!user) return res.status(400).json({ error: "Invalid code" });

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
    req.session.asUserId = null;
    req.session.user = sessionUser;
    res.json({ user: sessionUser });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Failed to login" });
  }
});

app.get("/api/auth/me", async (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
    Vary: "Cookie",
  });

  if (!req.session.user) return res.json({ user: null });

  const adminUser = await prisma.user.findUnique({
    where: { id: req.session.user.id },
    select: publicUserSelect,
  });

  if (!adminUser || adminUser.isDisabled) {
    req.session.destroy(() => {});
    return res.json({ user: null });
  }

  if (req.session.asUserId) {
    const asUser = await prisma.user.findUnique({
      where: { id: req.session.asUserId },
      select: publicUserSelect,
    });
    return res.json({
      user: asUser ? { ...asUser, _impersonating: true } : null,
      admin: adminUser,
    });
  }

  return res.json({ user: adminUser });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => {
    // ✅ use the same domain value as session config
    res.clearCookie("speexify.sid", {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
      domain: cookieDomain,
      path: "/",
    });
    res.json({ ok: true });
  });
});

/* ========================================================================== */
/*                   NEW AUTH: EMAIL VERIFICATION (RECOMMENDED)               */
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
/*                                 ADMIN: USERS                                */
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

app.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    let { email, name = "", role = "learner", timezone = null } = req.body;
    email = String(email || "")
      .toLowerCase()
      .trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: "User already exists" });

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

      req.session.asUserId = targetId;
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

/* ========================================================================== */
/*                               ADMIN: SESSIONS                               */
/*  ✅ New block powering the Admin dashboard                                 */
/* ========================================================================== */

// GET /api/admin/sessions   (?q=&userId=&teacherId=&range=upcoming|past&limit=&offset=)
app.get("/api/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    const {
      q = "",
      userId = "",
      teacherId = "",
      range = "",
      limit = "100",
      offset = "0",
    } = req.query;

    const now = new Date();
    const where = {
      ...(userId ? { userId: Number(userId) } : {}),
      ...(teacherId ? { teacherId: Number(teacherId) } : {}),
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { meetingUrl: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    if (range === "upcoming") {
      where.AND = [
        ...(where.AND || []),
        { startAt: { gte: now } },
        { status: { not: "canceled" } },
      ];
    } else if (range === "past") {
      where.AND = [
        ...(where.AND || []),
        {
          OR: [
            { endAt: { lt: now } },
            { AND: [{ endAt: null }, { startAt: { lt: now } }] },
          ],
        },
      ];
    }

    const [items, total] = await Promise.all([
      prisma.session.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
        },
        orderBy: [{ startAt: "desc" }, { id: "desc" }],
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.session.count({ where }),
    ]);

    res.json({ items, total });
  } catch (err) {
    console.error("admin.sessions.list error:", err);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

// POST /api/admin/sessions
// POST /api/admin/sessions  (flexible field names)
// CREATE (admin only)
// POST /api/admin/sessions
// Accepts aliases to be forgiving with the current UI:
//   learnerId | userId         -> required, must be a learner
//   tutorId   | teacherId      -> required, must be a teacher
//   start     | startAt (ISO)  -> required
//   durationMin OR endAt       -> one of them required
//   title?, meetingUrl?
app.post("/api/admin/sessions", requireAuth, requireAdmin, async (req, res) => {
  try {
    // ---- normalize & basic validation ---------------------------------------
    const learnerId = Number(req.body.learnerId ?? req.body.userId);
    const teacherId = Number(req.body.tutorId ?? req.body.teacherId);

    const startStr = String(req.body.start ?? req.body.startAt ?? "");
    const startAt = new Date(startStr);

    const durationMin =
      req.body.durationMin !== undefined && req.body.durationMin !== null
        ? Number(req.body.durationMin)
        : null;

    const endAtStr =
      req.body.endAt !== undefined && req.body.endAt !== null
        ? String(req.body.endAt)
        : null;
    const endAt = endAtStr ? new Date(endAtStr) : null;

    const title = (req.body.title ?? "").toString().trim() || "Lesson";
    const meetingUrl = (req.body.meetingUrl ?? "").toString().trim() || null;

    if (!learnerId || !teacherId)
      return res.status(400).json({
        error: "learnerId/userId and tutorId/teacherId are required",
      });

    if (!startStr || Number.isNaN(startAt.getTime()))
      return res
        .status(400)
        .json({ error: "start/startAt must be a valid ISO datetime" });

    if (!durationMin && !endAt)
      return res.status(400).json({ error: "Provide durationMin OR endAt" });

    // Compute endAt if only duration provided
    const finalEndAt =
      endAt || new Date(startAt.getTime() + Number(durationMin) * 60 * 1000);

    // ---- check users & roles -------------------------------------------------
    const [learner, teacher] = await Promise.all([
      prisma.user.findUnique({
        where: { id: learnerId },
        select: { id: true, role: true, isDisabled: true },
      }),
      prisma.user.findUnique({
        where: { id: teacherId },
        select: { id: true, role: true, isDisabled: true },
      }),
    ]);

    if (!learner) return res.status(404).json({ error: "Learner not found" });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });
    if (learner.isDisabled)
      return res.status(400).json({ error: "Learner is disabled" });
    if (teacher.isDisabled)
      return res.status(400).json({ error: "Teacher is disabled" });

    if (learner.role !== "learner" && learner.role !== "admin") {
      // allow admin to be scheduled as a learner if you want; otherwise enforce learner only
      return res
        .status(400)
        .json({ error: "learnerId must refer to a learner" });
    }
    if (teacher.role !== "teacher") {
      return res
        .status(400)
        .json({ error: "tutorId/teacherId must refer to a teacher" });
    }

    // ---- conflict check (excludeId: none on create) -------------------------
    const conflicts = await findSessionConflicts({
      startAt,
      endAt: finalEndAt,
      userId: learnerId,
      teacherId,
    });
    if (conflicts.length) {
      return res.status(409).json({ error: "Time conflict", conflicts });
    }

    // ---- create --------------------------------------------------------------
    const created = await prisma.session.create({
      data: {
        userId: learnerId,
        teacherId,
        title,
        startAt,
        endAt: finalEndAt,
        meetingUrl,
        status: "scheduled",
      },
      select: {
        id: true,
        title: true,
        userId: true,
        teacherId: true,
        startAt: true,
        endAt: true,
        meetingUrl: true,
        status: true,
      },
    });

    // optional audit
    await audit(req.user.id, "session_create", "Session", created.id, {
      learnerId,
      teacherId,
      startAt,
      endAt: finalEndAt,
    });

    return res.status(201).json({ ok: true, session: created });
  } catch (e) {
    console.error("admin.createSession error:", e);
    return res.status(500).json({ error: "Failed to create session" });
  }
});

// PATCH /api/admin/sessions/:id
app.patch(
  "/api/admin/sessions/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await prisma.session.findUnique({ where: { id } });
      if (!existing) return res.status(404).json({ error: "Not found" });

      const patch = {};
      const allowed = [
        "title",
        "meetingUrl",
        "status",
        "startAt",
        "endAt",
        "userId",
        "teacherId",
      ];
      for (const k of allowed) {
        if (req.body[k] !== undefined) patch[k] = req.body[k];
      }

      const start = patch.startAt ? new Date(patch.startAt) : existing.startAt;
      const end = patch.endAt ? new Date(patch.endAt) : existing.endAt;
      const userId = patch.userId ? Number(patch.userId) : existing.userId;
      const teacherId = patch.teacherId
        ? Number(patch.teacherId)
        : existing.teacherId;

      if (patch.startAt || patch.endAt || patch.userId || patch.teacherId) {
        const conflicts = await findSessionConflicts({
          startAt: start,
          endAt: end,
          userId,
          teacherId,
          excludeId: id,
        });
        if (conflicts.length) {
          return res.status(409).json({ error: "Time conflict", conflicts });
        }
      }

      if (patch.userId !== undefined) patch.userId = Number(patch.userId);
      if (patch.teacherId !== undefined)
        patch.teacherId = Number(patch.teacherId);
      if (patch.startAt !== undefined) patch.startAt = new Date(patch.startAt);
      if (patch.endAt !== undefined)
        patch.endAt = patch.endAt ? new Date(patch.endAt) : null;

      const updated = await prisma.session.update({
        where: { id },
        data: patch,
        include: {
          user: { select: { id: true, name: true, email: true } },
          teacher: { select: { id: true, name: true, email: true } },
        },
      });

      await audit(req.user.id, "session_update", "Session", id, patch);
      res.json(updated);
    } catch (err) {
      console.error("admin.sessions.patch error:", err);
      res.status(500).json({ error: "Failed to update session" });
    }
  }
);

// DELETE /api/admin/sessions/:id
app.delete(
  "/api/admin/sessions/:id",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.session.delete({ where: { id } });
      await audit(req.user.id, "session_delete", "Session", id);
      res.json({ ok: true });
    } catch (err) {
      console.error("admin.sessions.delete error:", err);
      res.status(500).json({ error: "Failed to delete session" });
    }
  }
);

/* ========================================================================== */
/*                             SESSIONS (LESSONS)                              */
/* ========================================================================== */

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

app.get("/api/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.viewUserId },
      include: {
        teacher: { select: { id: true, name: true, email: true } },
      },
      orderBy: { startAt: "asc" },
    });
    res.json(sessions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load sessions" });
  }
});

app.get("/api/teacher/sessions", requireAuth, async (req, res) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { teacherId: req.viewUserId },
      include: {
        user: { select: { id: true, email: true, name: true } },
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
/* ========================================================================== */
app.get("/api/teacher/summary", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const now = new Date();

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

    const nextSession = await prisma.session.findFirst({
      where: {
        teacherId: userId,
        status: { not: "canceled" },
        OR: [
          { startAt: { gte: now } },
          {
            AND: [
              { startAt: { lte: now } },
              { OR: [{ endAt: { gte: now } }, { endAt: null }] },
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
/* ========================================================================== */

app.get("/api/me/summary", requireAuth, async (req, res) => {
  const now = new Date();

  try {
    const nextSession = await prisma.session.findFirst({
      where: { userId: req.viewUserId, startAt: { gt: now } },
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

app.get("/api/me/sessions", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { range = "upcoming", limit = 10 } = req.query;
    const now = new Date();

    const whereBase =
      role === "teacher"
        ? { OR: [{ userId }, { teacherId: userId }] }
        : { userId };

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
                  { startAt: { gte: now } },
                  {
                    AND: [
                      { startAt: { lte: now } },
                      { OR: [{ endAt: { gte: now } }, { endAt: null }] },
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

app.get("/api/me/sessions-between", requireAuth, async (req, res) => {
  try {
    const userId = req.viewUserId;
    const role = req.user.role || "learner";
    const { start, end } = req.query;
    const includeCanceled = String(req.query.includeCanceled) === "true";

    const startAt = start ? new Date(start) : new Date("1970-01-01");
    const endAt = end ? new Date(end) : new Date("2999-12-31");

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

app.post("/api/sessions/:id/cancel", requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const sessionRow = await prisma.session.findUnique({ where: { id } });
    if (!sessionRow)
      return res.status(404).json({ error: "Session not found" });

    const isOwner = sessionRow.userId === req.user.id;
    const isTeacher = sessionRow.teacherId === req.user.id;
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

    const isOwner = s.userId === req.user.id;
    const isTeacher = s.teacherId === req.user.id;
    const isAdmin = req.user.role === "admin";
    if (!(isOwner || isTeacher || isAdmin)) {
      return res.status(403).json({ error: "Forbidden" });
    }

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

app.get("/health", (_req, res) => res.send("ok"));

app.get("/api/db-check", async (_req, res) => {
  try {
    const ok = await prisma.$queryRaw`select 1 as ok`;
    res.json(ok);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "DB not reachable" });
  }
});

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
