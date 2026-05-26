// src/routes/auth.js
import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { OAuth2Client } from "google-auth-library";
import crypto from "node:crypto";
import {
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "../config/session.js";
import { sendEmail } from "../services/emailService.js";
import { loginLimiter, authLimiter, emailCodeLimiter } from "../middleware/rateLimit.js";
import { logger } from "../lib/logger.js";
import {
  isSessionInvalidatedByPasswordChange,
  requireAuth,
} from "../middleware/auth-helpers.js";
import {
  createWsAuthToken,
  getWsAuthTokenTtlMs,
} from "../webrtcSignaling/token.js";

const router = Router();

// ---------------------------------------------------------------------------
// Password strength helper
// ---------------------------------------------------------------------------
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

// ---- Public user fields (for /me) ----
const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  timezone: true,
  language: true,
  isDisabled: true,
  passwordChangedAt: true,
  rateHourlyCents: true,
  ratePerSessionCents: true,
};

const googleUserSelect = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  timezone: true,
  language: true,
  isDisabled: true,
};

// ---- Codes + hashing ----
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

async function randomHashedPassword() {
  const rand = crypto.randomBytes(32).toString("hex");
  return await bcrypt.hash(rand, 10);
}

function getErrorMessage(err) {
  return (err && (err.message || err.toString())) || "unknown_error";
}

function isUniqueConstraintError(err) {
  return err?.code === "P2002";
}

function isGoogleCertificateFetchError(message) {
  const msg = String(message || "").toLowerCase();
  return [
    "failed to retrieve verification certificates",
    "getaddrinfo",
    "eai_again",
    "enotfound",
    "etimedout",
    "timeout",
    "network",
  ].some((marker) => msg.includes(marker));
}

function isGoogleTokenVerificationError(message) {
  const msg = String(message || "").toLowerCase();
  return [
    "wrong number of segments",
    "invalid_token",
    "invalid token",
    "token used too late",
    "token used too early",
    "audience",
    "audience mismatch",
    "wrong recipient",
    "issuer",
    "invalid token signature",
    "invalid signature",
    "jwt",
    "malformed",
    "expired",
    "no pem found",
    "can't parse token envelope",
    "can't parse token payload",
    "invalid value",
  ].some((marker) => msg.includes(marker));
}

function googleTokenVerificationMessage(message) {
  const msg = String(message || "").toLowerCase();
  if (
    msg.includes("audience") ||
    msg.includes("wrong recipient") ||
    msg.includes("client id")
  ) {
    return "Google sign-in is using a different OAuth client ID than the server. Please check the Google login configuration.";
  }

  return "Google sign-in could not be verified. Please try again.";
}

function googleErrorBody(error, message, details) {
  return {
    ok: false,
    error,
    message,
    ...(process.env.NODE_ENV !== "production" ? { details } : {}),
  };
}

function establishLoginSession(req, user, { loginAtMs = Date.now() } = {}) {
  req.session.asUserId = null;
  req.session.loginAt = loginAtMs;
  req.session.user = {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role,
    timezone: user.timezone ?? null,
    language: user.language ?? "en",
  };
}

async function findOrCreateGoogleUser({ email, name }) {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: googleUserSelect,
  });
  if (existing) return existing;

  const hashedPassword = await randomHashedPassword();

  try {
    return await prisma.user.create({
      data: { email, name, hashedPassword, role: "learner" },
      select: googleUserSelect,
    });
  } catch (err) {
    // Two Google callbacks for the same new account can arrive together.
    // If one request wins the insert, the other should continue as a login.
    if (isUniqueConstraintError(err)) {
      logger.warn({ email }, "[google] user create raced with existing account");
      return await prisma.user.findUnique({
        where: { email },
        select: googleUserSelect,
      });
    }

    throw err;
  }
}

/* ========================================================================== */
/*                                   LOGIN                                   */
/* ========================================================================== */

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
      avatarUrl: user.avatarUrl ?? null,
      role: user.role,
      timezone: user.timezone ?? null,
      language: user.language ?? "en",
    };
    establishLoginSession(req, sessionUser);
    res.json({ user: sessionUser });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Failed to login" });
  }
});

/* ========================================================================== */
/*                           GOOGLE OAUTH (ID TOKEN)                          */
/* ========================================================================== */

router.post("/google", authLimiter, async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID) {
      logger.error(
        {},
        "[google] Missing GOOGLE_CLIENT_ID env; cannot verify token."
      );
      return res.status(500).json(
        googleErrorBody(
          "config_error",
          "Google login is not configured on the server.",
          "GOOGLE_CLIENT_ID is missing"
        )
      );
    }

    const credential =
      typeof req.body?.credential === "string" ? req.body.credential : "";
    if (!credential) {
      return res.status(400).json(
        googleErrorBody(
          "missing_credential",
          "Google did not return a login credential. Please try again.",
          "credential is missing"
        )
      );
    }

    const origin = req.get("origin") || "unknown-origin";
    logger.info(
      { origin, audience: GOOGLE_CLIENT_ID.slice(0, 10) + "..." },
      "[google] verify start"
    );

    let ticket;
    try {
      ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: GOOGLE_CLIENT_ID,
      });
    } catch (err) {
      const msg = getErrorMessage(err);
      logger.warn({ err: msg, origin }, "[google] token verification failed");

      if (isGoogleCertificateFetchError(msg)) {
        return res
          .status(503)
          .json(
            googleErrorBody(
              "google_verification_unavailable",
              "Google sign-in could not be verified right now. Please try again in a moment.",
              msg
            )
          );
      }

      if (isGoogleTokenVerificationError(msg)) {
        return res
          .status(401)
          .json(
            googleErrorBody(
              "invalid_google_token",
              googleTokenVerificationMessage(msg),
              msg
            )
          );
      }

      return res
        .status(401)
        .json(
          googleErrorBody(
            "invalid_google_token",
            googleTokenVerificationMessage(msg),
            msg
          )
        );
    }

    const payload = ticket.getPayload();
    const email = String(payload?.email || "")
      .toLowerCase()
      .trim();
    const emailVerified = Boolean(payload?.email_verified);
    const name = payload?.name ? String(payload.name).trim() : null;

    if (!email || !emailVerified) {
      return res.status(400).json(
        googleErrorBody(
          "unverified_email",
          "Your Google account email must be verified before signing in.",
          "missing or unverified email in Google token"
        )
      );
    }

    const user = await findOrCreateGoogleUser({ email, name });
    if (!user) {
      throw new Error("Google user lookup returned no user");
    }

    if (user?.isDisabled) {
      return res.status(403).json(
        googleErrorBody(
          "account_disabled",
          "This account is disabled. Please contact support.",
          `disabled account: ${email}`
        )
      );
    }

    establishLoginSession(req, user);

    req.session.save((saveErr) => {
      if (saveErr) {
        logger.error({ err: saveErr }, "[google] session.save error");
        return res.status(500).json(
          googleErrorBody(
            "session_error",
            "Google sign-in worked, but the login session could not be saved. Please try again.",
            getErrorMessage(saveErr)
          )
        );
      }
      res.set({
        "Cache-Control":
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
        "Surrogate-Control": "no-store",
        Vary: "Cookie",
      });
      logger.info({ email }, "[google] verify ok → session established");
      return res.json({ ok: true, user: req.session.user });
    });
  } catch (err) {
    const msg = getErrorMessage(err);
    logger.error({ err }, "[google] login error");
    return res
      .status(500)
      .json(
        googleErrorBody(
          "server_error",
          "We could not complete Google sign-in. Please try again.",
          msg
        )
      );
  }
});

router.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE_NAME, {
      ...sessionCookieOptions,
      maxAge: undefined, // clear immediately
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

  if (isSessionInvalidatedByPasswordChange(req, adminUser)) {
    req.session.destroy(() => {});
    return res
      .status(401)
      .json({ error: "Session expired, please log in again" });
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

/* ========================================================================== */
/*                           WEBSOCKET AUTH TOKEN                             */
/* ========================================================================== */

router.get("/ws-token", requireAuth, (req, res) => {
  try {
    const userId = String(req.viewUserId || req.user?.id || "").trim();
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { token, expiresAt } = createWsAuthToken({
      userId,
      ttlMs: getWsAuthTokenTtlMs(),
    });

    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
      "Surrogate-Control": "no-store",
      Vary: "Cookie",
    });

    return res.json({ token, expiresAt });
  } catch (err) {
    logger.error({ err }, "Failed to issue websocket token");
    return res.status(500).json({ error: "Failed to issue websocket token" });
  }
});

/* ========================================================================== */
/*                          PASSWORD RESET (2-step)                           */
/* ========================================================================== */

router.post("/password/reset/start", emailCodeLimiter, async (req, res) => {
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

    // If sendEmail throws, we log but still respond ok:true (no user enumeration)
    try {
      await sendEmail(
        email,
        "Your Speexify password reset code",
        `<p>Use this code to reset your password:</p>
         <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
         <p>This code expires in 10 minutes.</p>`
      );
    } catch (err) {
      logger.error({ err, email }, "password/reset/start sendEmail failed");
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "password/reset/start error");
    return res.json({ ok: true });
  }
});

router.post("/password/reset/complete", emailCodeLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || "")
      .toLowerCase()
      .trim();
    const code = String(req.body?.code || "").trim();
    const newPassword = String(req.body?.newPassword || "");

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "A 6-digit code is required" });
    }

    // Reuse shared password validation
    const pwError = validatePasswordStrength(newPassword, "New password");
    if (pwError) {
      return res.status(400).json({ error: pwError });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't leak whether the email exists in a detailed way
      return res.status(400).json({ error: "Invalid code" });
    }

    const pr = await prisma.passwordResetCode.findUnique({ where: { email } });
    if (!pr) {
      return res.status(400).json({ error: "Invalid or expired code" });
    }

    // Treat missing expiresAt as invalid/expired for safety
    const now = new Date();
    if (!pr.expiresAt || now >= pr.expiresAt) {
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
    const passwordChangedAt = new Date();
    await prisma.user.update({
      where: { email },
      data: { hashedPassword, passwordChangedAt },
    });

    await prisma.passwordResetCode.delete({ where: { email } });

    // Log the user in immediately
    establishLoginSession(req, user, {
      loginAtMs: passwordChangedAt.getTime(),
    });

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "password/reset/complete error");
    return res.status(500).json({ error: "Failed to reset password" });
  }
});

/* ========================================================================== */
/*                 EMAIL VERIFICATION REGISTER (2-step)                       */
/* ========================================================================== */

router.post("/register/start", emailCodeLimiter, async (req, res) => {
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

    // 🔹 IMPORTANT: if sendEmail fails, tell the frontend explicitly
    try {
      await sendEmail(
        email,
        "Your Speexify verification code",
        `<p>Your verification code is:</p>
         <p style="font-size:20px;font-weight:700;letter-spacing:2px">${code}</p>
         <p>This code expires in 10 minutes.</p>`
      );
    } catch (err) {
      logger.error({ err, email }, "register/start sendEmail failed");
      return res.status(500).json({
        error:
          "Failed to send verification email. Please check your email and try again.",
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "register/start error");
    return res.status(500).json({ error: "Failed to start registration" });
  }
});

router.post("/register/complete", emailCodeLimiter, async (req, res) => {
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

    const passwordError = validatePasswordStrength(password, "Password");
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) {
      return res.status(409).json({ error: "Email is already registered" });
    }

    const v = await prisma.verificationCode.findUnique({ where: { email } });
    if (!v) {
      return res
        .status(400)
        .json({ error: "No verification code found for this email" });
    }

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
        avatarUrl: true,
        role: true,
        timezone: true,
        language: true,
        isDisabled: true,
      },
    });

    await prisma.verificationCode.delete({ where: { email } });

    establishLoginSession(req, user);

    return res.json({ ok: true, user });
  } catch (err) {
    logger.error({ err }, "register/complete error");
    return res.status(500).json({ error: "Failed to complete registration" });
  }
});

export default router;
