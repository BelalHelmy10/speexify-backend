// src/routes/admin.js
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import nodemailer from "nodemailer";
import crypto from "node:crypto";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";

const prisma = new PrismaClient();
const router = Router();

/* -------------------------------------------------------------------------- */
/* Email helpers (same behaviour as other files)                              */
/* -------------------------------------------------------------------------- */

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
    .then(() => logger.info({}, "📨 SMTP transporter ready (admin routes)"))
    .catch((err) => {
      logger.warn(
        { err },
        "⚠️ SMTP verify failed in admin routes. Falling back to console email."
      );
      transporter = null;
    });
}

async function sendEmail(to, subject, html) {
  if (!transporter) {
    logger.info({ to, subject, html }, "[DEV EMAIL] Outgoing email (DEV mode)");
    return;
  }
  await transporter.sendMail({ from: EMAIL_FROM, to, subject, html });
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

async function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    await prisma.audit.create({
      data: { actorId, action, entity, entityId, meta },
    });
  } catch (e) {
    logger.error({ err: e }, "audit failed");
  }
}

/* ========================================================================== */
/*                                ADMIN: USERS                                */
/* ========================================================================== */

// GET /api/admin/users
router.get(
  "/admin/users",
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

// POST /api/admin/users
router.post("/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    let { email, name = "", role = "learner", timezone = null } = req.body;
    email = String(email || "")
      .toLowerCase()
      .trim();
    if (!email) return res.status(400).json({ error: "email required" });

    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: "User already exists" });

    const rand = crypto.randomBytes(16).toString("hex");
    const hashedPassword = await crypto
      .createHash("sha256")
      .update(rand)
      .digest("hex"); // just random, real login will be via reset

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
    logger.error({ err }, "admin.createUser error");
    res.status(500).json({ error: "Failed to create user" });
  }
});

// PATCH /api/admin/users/:id
router.patch(
  "/admin/users/:id",
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
      logger.error({ err }, "admin.patchUser error");
      res.status(500).json({ error: "Failed to update user" });
    }
  }
);

// POST /api/admin/users/:id/reset-password
router.post(
  "/admin/users/:id/reset-password",
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
      logger.error({ err }, "admin.resetPassword error");
      res.status(500).json({ error: "Failed to send reset" });
    }
  }
);

/* ========================================================================== */
/*                              ADMIN: IMPERSONATE                            */
/* ========================================================================== */

// POST /api/admin/impersonate/:id
router.post(
  "/admin/impersonate/:id",
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
      logger.error({ err }, "admin.impersonateStart error");
      res.status(500).json({ error: "Failed to impersonate" });
    }
  }
);

// POST /api/admin/impersonate/stop
router.post(
  "/admin/impersonate/stop",
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
      logger.error({ err }, "admin.impersonateStop error");
      res.status(500).json({ error: "Failed to stop impersonation" });
    }
  }
);

export default router;
