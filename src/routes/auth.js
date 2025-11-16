// src/routes/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { OAuth2Client } from "google-auth-library";
import crypto from "node:crypto";
import { isProd, COOKIE_DOMAIN } from "../config/env.js";
import { sendEmail } from "../services/emailService.js";
import { loginLimiter } from "../middleware/rateLimit.js";

const prisma = new PrismaClient();
const router = Router();

//validating passwords

function validatePasswordStrength(password, label = "Password") {
  if (!password || typeof password !== "string") {
    return `${label} is required`;
  }

  if (password.length < 8) {
    return `${label} must be at least 8 characters`;
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return `${label} must contain at least one letter and one number`;
  }

  return null; // ok
}

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

router.post("/login", loginLimiter, async (req, res) => {
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

    // Email format
    if (!/^\S+@\S+\.\S+$/.test(email))
      return res.status(400).json({ error: "Valid email is required" });

    // Code format
    if (!/^\d{6}$/.test(code))
      return res.status(400).json({ error: "A 6-digit code is required" });

    // NEW PASSWORD POLICY (embedded here)
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: "New password must be at least 8 characters" });
    }
    if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
      return res.status(400).json({
        error: "New password must contain at least one letter and one number",
      });
    }

    // User exists?
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: "Invalid code" });

    // Get reset entry
    const pr = await prisma.passwordResetCode.findUnique({ where: { email } });
    if (!pr) return res.status(400).json({ error: "Invalid or expired code" });

    // Expired?
    if (new Date() > pr.expiresAt) {
      await prisma.passwordResetCode.delete({ where: { email } });
      return res
        .status(400)
        .json({ error: "Code expired. Request a new one." });
    }

    // Too many attempts?
    if (pr.attempts >= 5) {
      await prisma.passwordResetCode.delete({ where: { email } });
      return res
        .status(429)
        .json({ error: "Too many attempts. Try again later." });
    }

    // Check code
    const ok = pr.codeHash === hashCode(code);
    if (!ok) {
      await prisma.passwordResetCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: "Invalid code" });
    }

    // Update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { email },
      data: { hashedPassword },
    });

    // Cleanup
    await prisma.passwordResetCode.delete({ where: { email } });

    // Log them in
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

// Add this helper somewhere above the route (top of file is fine)
function validatePasswordStrength(password, label = "Password") {
  if (!password || typeof password !== "string") {
    return `${label} is required`;
  }

  if (password.length < 8) {
    return `${label} must be at least 8 characters`;
  }

  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return `${label} must contain at least one letter and one number`;
  }

  return null; // valid
}

router.post("/register/complete", async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "");

    // Email format
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    // 6-digit code
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "A 6-digit code is required" });
    }

    // NEW PASSWORD POLICY
    const passwordError = validatePasswordStrength(password, "Password");
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    // User exists?
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    // Find verification code entry
    const v = await prisma.verificationCode.findUnique({ where: { email } });
    if (!v) {
      return res
        .status(400)
        .json({ error: "No verification code found for this email" });
    }

    // Expired?
    if (new Date() > v.expiresAt) {
      await prisma.verificationCode.delete({ where: { email } });
      return res.status(400).json({ error: "Verification code has expired" });
    }

    // Too many attempts?
    if (v.attempts >= 5) {
      await prisma.verificationCode.delete({ where: { email } });
      return res
        .status(429)
        .json({ error: "Too many attempts. Request a new code." });
    }

    // Check the code
    const isMatch = v.codeHash === hashCode(code);
    if (!isMatch) {
      await prisma.verificationCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: "Invalid verification code" });
    }

    // Passed → create user
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

    // Cleanup
    await prisma.verificationCode.delete({ where: { email } });

    // Create session
    req.session.asUserId = null;
    req.session.user = user;

    return res.json({ ok: true, user });
  } catch (err) {
    console.error("register/complete error:", err);
    return res.status(500).json({ error: "Failed to complete registration" });
  }
});

export default router;
