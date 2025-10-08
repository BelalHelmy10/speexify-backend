// api/routes/auth.js

// ─────────────────────────────────────────────────────────────────────────────
// Purpose: Extend /api/auth with email verification for registration
// Routes:
//   POST /api/auth/register/start    -> send code if email unused
//   POST /api/auth/register/complete -> verify code and create user
// ─────────────────────────────────────────────────────────────────────────────
const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const bcrypt = require("bcryptjs");

// (Optional) email sender: uses Nodemailer if SMTP env is set; otherwise logs
let transporter = null;
try {
  const nodemailer = require("nodemailer");
  if (process.env.SMTP_HOST) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
} catch (_) {}

async function sendEmail(to, subject, html) {
  if (transporter) {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM || "no-reply@speexify.local",
      to,
      subject,
      html,
    });
  } else {
    console.log(`\n[DEV EMAIL] To: ${to}\nSubject: ${subject}\n${html}\n`);
  }
}

// Helpers
const now = () => Date.now();
const genCode = () => String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
const hashCode = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register/start
// - Valid email? Not registered already?
// - Rate limit: resend every 60s
// - Store/replace hashed code (expires in 10 min)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register/start", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing)
      return res.status(409).json({ error: "Email is already registered" });

    const existingCode = await prisma.verificationCode.findUnique({
      where: { email },
    });
    // simple 60s cooldown using updatedAt
    if (
      existingCode &&
      now() - new Date(existingCode.updatedAt).getTime() < 60_000
    ) {
      const wait = Math.ceil(
        (60_000 - (now() - new Date(existingCode.updatedAt).getTime())) / 1000
      );
      return res
        .status(429)
        .json({ error: `Please wait ${wait}s before resending` });
    }

    const code = genCode();
    const data = {
      email,
      codeHash: hashCode(code),
      expiresAt: new Date(now() + 10 * 60_000),
      attempts: 0,
    };

    // upsert per-email code
    await prisma.verificationCode.upsert({
      where: { email },
      update: { ...data },
      create: { ...data },
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
    console.error(err);
    return res.status(500).json({ error: "Failed to start registration" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register/complete
// - Validate email, 6-digit code, and password
// - Check hash + expiry + attempts
// - Create user (password hashed) and delete the verification row
// ─────────────────────────────────────────────────────────────────────────────
router.post("/register/complete", async (req, res) => {
  try {
    const email = String(req.body?.email || "").toLowerCase();
    const code = String(req.body?.code || "");
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

    const userExists = await prisma.user.findUnique({ where: { email } });
    if (userExists)
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

    const isMatch = v.codeHash === hashCode(code.trim());
    if (!isMatch) {
      await prisma.verificationCode.update({
        where: { email },
        data: { attempts: { increment: 1 } },
      });
      return res.status(400).json({ error: "Invalid verification code" });
    }

    // Create user (hash password)
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, name, password: passwordHash, role: "learner" },
      select: { id: true, email: true, name: true, role: true },
    });

    // Clear verification row
    await prisma.verificationCode.delete({ where: { email } });

    // (Optional) create session cookie here

    return res.json({ ok: true, user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to complete registration" });
  }
});

module.exports = router;
