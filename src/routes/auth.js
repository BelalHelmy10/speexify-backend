// src/routes/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { isProd, COOKIE_DOMAIN } from "../config/env.js";

const prisma = new PrismaClient();
const router = Router();

/* ========================================================================== */
/*                      SHARED HELPERS (copied from app.js)                  */
/* ========================================================================== */

// ---- Google OAuth config ----
const GOOGLE_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
  process.env.GOOGLE_CLIENT_ID ||
  "";

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---- Cookies / session helpers ----
const cookieDomain = COOKIE_DOMAIN || undefined;

// ---- Public user fields (for /me) ----
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

// ---- Codes + hashing ----
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

async function randomHashedPassword() {
  const rand = crypto.randomBytes(32).toString("hex");
  return await bcrypt.hash(rand, 10);
}

// ---- Email sender (same behaviour as app.js) ----
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
    .then(() => console.log("📧 SMTP transporter ready (auth routes)"))
    .catch((err) => {
      console.warn(
        "⚠️  SMTP verify failed in auth routes. Falling back to console email.",
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

router.post("/login", async (req, res) => {
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

/* ========================================================================== */
/*                           GOOGLE OAUTH (ID TOKEN)                           */
/* ========================================================================== */

router.post("/google", async (req, res) => {
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

router.post("/logout", (req, res) => {
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

router.get("/me", async (req, res) => {
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

router.post("/password/reset/start", async (req, res) => {
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

router.post("/password/reset/complete", async (req, res) => {
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

router.post("/register/start", async (req, res) => {
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

router.post("/register/complete", async (req, res) => {
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

export default router;
