// src/app.js

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
import cors from "cors";
import { performance } from "node:perf_hooks";

// ─────────────────────────────────────────────────────────────────────────────
import bcrypt from "bcryptjs";
import { prisma } from "./lib/prisma.js";
import crypto from "node:crypto";
import {
  PAYMOB_API_KEY,
  PAYMOB_INTEGRATION_ID,
  PAYMOB_IFRAME_ID,
  PAYMOB_HMAC_SECRET,
  ALLOWED_ORIGINS,
  OBS_METRICS_TOKEN,
} from "./config/env.js";
import { sessionMiddleware } from "./middleware/session.js";
import authRoutes from "./routes/auth.js";
import paymentsRoutes from "./routes/payments.js";
import sessionsRoutes from "./routes/sessions/index.js";
import packagesRoutes from "./routes/packages.js";
import adminRoutes from "./routes/admin.js";
import onboardingAssessmentRoutes from "./routes/onboarding-assessment.js";
import {
  finalizeExpiredSessionsForUser,
  finalizeExpiredSessionsForTeacher,
} from "./services/sessionsService.js";
import { sendEmail } from "./services/emailService.js";
import { requireAuth, requireAdmin } from "./middleware/auth-helpers.js";
import { csrfMiddleware, csrfErrorHandler } from "./middleware/csrf.js";
import { validateRequest, formatZodError } from "./middleware/validateRequest.js";
import { contactEmailLimiter, contactIpLimiter } from "./middleware/rateLimit.js";
import { logger } from "./lib/logger.js";
import notificationsRoutes from "./routes/notifications.js";
import devEmailTestRoutes from "./routes/devEmailTest.js";
import supportRoutes from "./routes/support.js";
import availabilityRoutes from "./routes/availability.js";
import calendarRoutes from "./routes/calendar.js";
import discountRoutes from "./routes/discounts.js";
import privacyRoutes from "./routes/privacy.js";
import {
  buildRequestContext,
  runWithRequestContext,
} from "./observability/requestContext.js";
import {
  getMetricsSnapshot,
  recordHttpRequestEnd,
  recordHttpRequestStart,
  toPrometheusMetrics,
} from "./observability/metrics.js";
import {
  deleteAvatarFile,
  profileAvatarUpload,
  resolveAvatarPath,
  saveAvatarFile,
} from "./lib/profileAvatarUpload.js";

const app = express();

// Initialize Sentry BEFORE other middlewares
initSentry(app);

axios.defaults.withCredentials = true;

// Base URL for Paymob APIs
const PAYMOB_BASE = "https://accept.paymob.com/api";

if (
  !PAYMOB_API_KEY ||
  !PAYMOB_INTEGRATION_ID ||
  !PAYMOB_IFRAME_ID ||
  !PAYMOB_HMAC_SECRET
) {
  logger.warn(
    "⚠️  Missing one or more Paymob env vars (PAYMOB_API_KEY, PAYMOB_INTEGRATION_ID, PAYMOB_IFRAME_ID, PAYMOB_HMAC_SECRET). Test mode will fail until set."
  );
}

function getRoutePattern(req) {
  const routePath = req.route?.path;
  if (routePath) {
    const base = req.baseUrl || "";
    return `${base}${routePath}`.replace(/\/+/g, "/");
  }

  const rawPath = req.path || req.originalUrl || "";
  const pathOnly = String(rawPath).split("?")[0];
  return pathOnly || "unknown";
}

function safeTokenCompare(given, expected) {
  const givenBuf = Buffer.from(String(given || ""));
  const expectedBuf = Buffer.from(String(expected || ""));
  if (givenBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(givenBuf, expectedBuf);
}

function isMetricsAuthorized(req) {
  if (!OBS_METRICS_TOKEN) return false;
  const candidate =
    req.get("x-metrics-token") ||
    req.query.token ||
    req.query.metricsToken ||
    "";
  return safeTokenCompare(candidate, OBS_METRICS_TOKEN);
}

const SECURITY_TXT = [
  "Contact: mailto:security@speexify.com",
  "Canonical: https://speexify.com/.well-known/security.txt",
  "Policy: https://speexify.com/security",
  "Preferred-Languages: en, ar",
  "Expires: 2027-12-31T23:59:59.000Z",
].join("\n");

/* ========================================================================== */
/*                               MIDDLEWARE                                   */
/* ========================================================================== */

app.use(express.json());
app.set("trust proxy", 1);
app.use(
  helmet({
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);

// Observability baseline: request context + structured access logs + metrics
app.use((req, res, next) => {
  const context = buildRequestContext(req);
  const startedAt = performance.now();
  let finalized = false;

  res.setHeader("x-request-id", context.requestId);
  res.setHeader("x-trace-id", context.traceId);

  recordHttpRequestStart();

  const finalize = (reason) => {
    if (finalized) return;
    finalized = true;

    const durationMs = Number((performance.now() - startedAt).toFixed(2));
    const statusCode =
      reason === "close" && !res.writableEnded ? 499 : res.statusCode || 500;
    const route = getRoutePattern(req);
    const userId = req.session?.user?.id || null;
    const viewUserId = req.viewUserId || null;

    recordHttpRequestEnd({
      method: req.method,
      route,
      statusCode,
      durationMs,
    });

    logger.info(
      {
        event: "http_request",
        method: req.method,
        route,
        statusCode,
        durationMs,
        requestId: context.requestId,
        traceId: context.traceId,
        userId,
        viewUserId,
        ip: req.ip,
        userAgent: req.get("user-agent") || "",
      },
      "http request completed"
    );
  };

  res.once("finish", () => finalize("finish"));
  res.once("close", () => finalize("close"));

  runWithRequestContext(context, () => next());
});

// CORS configured from ALLOWED_ORIGINS
const allowedOrigins = ALLOWED_ORIGINS;

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        // e.g. curl, Postman, server-to-server
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true, // allow cookies / auth headers
  })
);

app.get("/api/health", (_req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
    "Surrogate-Control": "no-store",
  });
  return res.json({ ok: true });
});

app.use(sessionMiddleware);

// CSRF protection (middleware decides which paths to skip)
app.use(csrfMiddleware);

// Endpoint to fetch a CSRF token (frontend will call this)
app.get("/api/csrf-token", (req, res) => {
  return res.json({ csrfToken: req.csrfToken() });
});

// Mount routes
app.use("/api/auth", authRoutes);
app.use("/api/discounts", discountRoutes);
app.use("/api/payments", paymentsRoutes);
app.use("/api", sessionsRoutes);
app.use("/api", packagesRoutes); // FIX: packages route handles /api/packages
app.use("/api", adminRoutes);
app.use("/api", onboardingAssessmentRoutes);
app.use("/api", notificationsRoutes);
app.use("/api", devEmailTestRoutes);
app.use("/api/support", supportRoutes);
app.use("/api", availabilityRoutes);
app.use("/api", calendarRoutes);
app.use("/api/privacy", privacyRoutes);

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

const RoleFilterSchema = z.enum(["learner", "teacher", "admin"]);
const ActiveFilterSchema = z.union([
  z.literal(""),
  z.literal("0"),
  z.literal("1"),
]);

const LANGUAGE_OPTIONS = ["en", "ar"];
const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  emailSessionReminders: true,
  emailSessionChanges: true,
  inAppSessionReminders: true,
  weeklyProgressDigest: true,
  productUpdates: false,
  reminderLeadTime: "24h",
});

function isValidTimeZone(value) {
  if (!value) return true;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function validatePasswordStrength(password, label = "New password") {
  if (!password || typeof password !== "string") return `${label} is required`;
  if (password.length < 8) return `${label} must be at least 8 characters`;
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    return `${label} must contain at least one letter and one number`;
  }
  return null;
}

const HTML_ESCAPE_CHARS = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE_CHARS[char]);
}

function safeDisplayText(value, fallback = "-") {
  const text = String(value ?? "").trim();
  return text ? escapeHtml(text) : fallback;
}

function safeEmailSubject(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

const ContactBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email(),
    company: z.string().trim().max(120).optional(),
    phone: z.string().trim().max(40).optional(),
    role: z.string().trim().max(80).optional(),
    topic: z.string().trim().max(120).optional(),
    budget: z.string().trim().max(80).optional(),
    locale: z.enum(["en", "ar"]).optional(),
    message: z.string().trim().min(1).max(5000),
  })
  .strict();

const ProfilePatchBodySchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    timezone: z.string().trim().max(80).nullable().optional(),
    language: z.enum(LANGUAGE_OPTIONS).nullable().optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one profile field is required",
  })
  .superRefine((payload, ctx) => {
    if (payload.timezone && !isValidTimeZone(payload.timezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timezone"],
        message: "Invalid time zone",
      });
    }
  });

function handleProfileAvatarUpload(req, res, next) {
  profileAvatarUpload.single("avatar")(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({
      error: error.message || "Failed to upload profile photo",
    });
  });
}

const ChangePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  })
  .strict()
  .superRefine((payload, ctx) => {
    const error = validatePasswordStrength(payload.newPassword);
    if (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["newPassword"],
        message: error,
      });
    }
  });

const NotificationPreferencesBodySchema = z
  .object({
    emailSessionReminders: z.boolean().optional(),
    emailSessionChanges: z.boolean().optional(),
    inAppSessionReminders: z.boolean().optional(),
    weeklyProgressDigest: z.boolean().optional(),
    productUpdates: z.boolean().optional(),
    reminderLeadTime: z.enum(["1h", "6h", "24h", "none"]).optional(),
  })
  .strict()
  .refine((payload) => Object.keys(payload).length > 0, {
    message: "At least one preference is required",
  });

const UsersQuerySchema = z.object({
  role: z.union([RoleFilterSchema, z.literal("")]).optional().default(""),
  q: z.string().trim().max(120).optional().default(""),
  active: ActiveFilterSchema.optional().default(""),
});

const LearnersQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  active: ActiveFilterSchema.optional().default("1"),
});

const TeachersQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  active: ActiveFilterSchema.optional().default(""),
});

/* ========================================================================== */
/*                              HEALTH / HELLO                                */
/* ========================================================================== */

app.get("/", (_req, res) => res.send("Hello from Speexify API 🚀"));
app.get("/api/_which-app", (_req, res) => {
  res.json({ ok: true, from: "src/app.js", ts: Date.now() });
});

app.get("/api/message", (_req, res) =>
  res.json({ message: "Hello from the backend 👋" })
);

app.get("/security.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8");
  return res.send(`${SECURITY_TXT}\n`);
});

app.get("/.well-known/security.txt", (_req, res) => {
  res.type("text/plain; charset=utf-8");
  return res.send(`${SECURITY_TXT}\n`);
});

app.get("/metrics", (req, res) => {
  if (!isMetricsAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.send(toPrometheusMetrics());
});

app.get("/api/observability/summary", requireAuth, requireAdmin, (req, res) => {
  const parsedWindowMs = Number(req.query.windowMs);
  const windowMs =
    Number.isFinite(parsedWindowMs) && parsedWindowMs > 0
      ? Math.floor(parsedWindowMs)
      : undefined;

  const snapshot = getMetricsSnapshot({ windowMs });
  return res.json(snapshot);
});

/* ========================================================================== */
/*                             PUBLIC: CONTACT                                */
/* ========================================================================== */
// NOTE: /api/packages is now handled by packagesRoutes (removed duplicate)

app.post("/api/contact", contactIpLimiter, validateRequest({ body: ContactBodySchema }), contactEmailLimiter, async (req, res) => {
  const { name, email, company, phone, role, topic, budget, message } =
    req.body;
  const subject = safeEmailSubject(
    `[Contact] ${topic || "General"} - ${name || "Website visitor"}`
  );

  const html = `
    <h2>New contact form message</h2>
    <p><b>Name:</b> ${safeDisplayText(name)}</p>
    <p><b>Email:</b> ${safeDisplayText(email)}</p>
    <p><b>Company:</b> ${safeDisplayText(company)}</p>
    <p><b>Phone:</b> ${safeDisplayText(phone)}</p>
    <p><b>Role:</b> ${safeDisplayText(role)}</p>
    <p><b>Topic:</b> ${safeDisplayText(topic)}</p>
    <p><b>Budget:</b> ${safeDisplayText(budget)}</p>
    <hr/>
    <pre style="font: inherit; white-space: pre-wrap;">${escapeHtml(message)}</pre>
  `;

  try {
    await sendEmail("hello@speexify.com", subject || "[Contact] New message", html);
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
          avatarUrl: true,
          role: true,
          timezone: true,
          language: true,
        },
      });

      req.session.asUserId = null;
      req.session.loginAt = Date.now();
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
        avatarUrl: true,
        role: true,
        timezone: true,
        language: true,
        notificationPreferences: true,
        calendarFeedRevokedAt: true,
        passwordChangedAt: true,
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

app.patch(
  "/api/me",
  requireAuth,
  validateRequest({ body: ProfilePatchBodySchema }),
  async (req, res) => {
    try {
      const { name, timezone, language } = req.body;
      const data = {};
      if (Object.prototype.hasOwnProperty.call(req.body, "name")) {
        data.name = name?.trim() || null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "timezone")) {
        data.timezone = timezone || null;
      }
      if (Object.prototype.hasOwnProperty.call(req.body, "language")) {
        data.language = language || "en";
      }

      const updated = await prisma.user.update({
        where: { id: req.viewUserId },
        data,
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          role: true,
          timezone: true,
          language: true,
          notificationPreferences: true,
          calendarFeedRevokedAt: true,
          passwordChangedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (req.viewUserId === req.user.id) {
        req.session.user = {
          ...req.session.user,
          name: updated.name,
          avatarUrl: updated.avatarUrl,
          timezone: updated.timezone,
          language: updated.language,
        };
      }

      res.json(updated);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to update profile" });
    }
  }
);

app.post(
  "/api/me/avatar",
  requireAuth,
  handleProfileAvatarUpload,
  async (req, res) => {
    let nextAvatarUrl = "";
    try {
      const current = await prisma.user.findUnique({
        where: { id: req.viewUserId },
        select: { avatarUrl: true },
      });

      nextAvatarUrl = saveAvatarFile(req.viewUserId, req.file);
      const updated = await prisma.user.update({
        where: { id: req.viewUserId },
        data: { avatarUrl: nextAvatarUrl },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          role: true,
          timezone: true,
          language: true,
          notificationPreferences: true,
          calendarFeedRevokedAt: true,
          passwordChangedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      deleteAvatarFile(current?.avatarUrl);

      if (req.viewUserId === req.user.id) {
        req.session.user = {
          ...req.session.user,
          avatarUrl: updated.avatarUrl,
        };
      }

      res.json(updated);
    } catch (error) {
      logger.warn(
        { err: error, userId: req.viewUserId },
        "Failed to upload profile photo"
      );
      deleteAvatarFile(nextAvatarUrl);
      res
        .status(error.statusCode || 500)
        .json({ error: error.message || "Failed to upload profile photo" });
    }
  }
);

app.delete("/api/me/avatar", requireAuth, async (req, res) => {
  try {
    const current = await prisma.user.findUnique({
      where: { id: req.viewUserId },
      select: { avatarUrl: true },
    });

    const updated = await prisma.user.update({
      where: { id: req.viewUserId },
      data: { avatarUrl: null },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        timezone: true,
        language: true,
        notificationPreferences: true,
        calendarFeedRevokedAt: true,
        passwordChangedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    deleteAvatarFile(current?.avatarUrl);

    if (req.viewUserId === req.user.id) {
      req.session.user = {
        ...req.session.user,
        avatarUrl: null,
      };
    }

    res.json(updated);
  } catch (error) {
    logger.warn(
      { err: error, userId: req.viewUserId },
      "Failed to remove profile photo"
    );
    res.status(500).json({ error: "Failed to remove profile photo" });
  }
});

app.get("/api/me/avatar/:filename", requireAuth, (req, res) => {
  const filePath = resolveAvatarPath(req.params.filename);
  if (!filePath) return res.status(404).json({ error: "Not found" });
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) {
      res.status(error.statusCode || 404).json({ error: "Not found" });
    }
  });
});

app.get("/api/me/notification-preferences", requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.viewUserId },
      select: { notificationPreferences: true },
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      ...(user.notificationPreferences || {}),
    });
  } catch (err) {
    logger.error({ err, userId: req.viewUserId }, "GET /api/me/notification-preferences failed");
    res.status(500).json({ error: "Failed to load notification preferences" });
  }
});

app.patch(
  "/api/me/notification-preferences",
  requireAuth,
  validateRequest({ body: NotificationPreferencesBodySchema }),
  async (req, res) => {
    try {
      const current = await prisma.user.findUnique({
        where: { id: req.viewUserId },
        select: { notificationPreferences: true },
      });

      if (!current) return res.status(404).json({ error: "User not found" });

      const notificationPreferences = {
        ...DEFAULT_NOTIFICATION_PREFERENCES,
        ...(current.notificationPreferences || {}),
        ...req.body,
      };

      const updated = await prisma.user.update({
        where: { id: req.viewUserId },
        data: { notificationPreferences },
        select: { notificationPreferences: true },
      });

      res.json(updated.notificationPreferences);
    } catch (err) {
      logger.error({ err, userId: req.viewUserId }, "PATCH /api/me/notification-preferences failed");
      res.status(500).json({ error: "Failed to save notification preferences" });
    }
  }
);

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
        type: true,
        capacity: true,
        participants: {
          where: { status: { not: "canceled" } },
          select: { userId: true },
        },
      },
    });

    // Add participant count to next session
    const nextTeachShaped = nextTeach
      ? {
        ...nextTeach,
        participantCount: nextTeach.participants?.length || 0,
      }
      : null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timezone: true },
    });

    res.json({
      nextTeach: nextTeachShaped,
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
    logger.info(
      {
        role: req.user?.role,
        userId: req.user?.id,
        viewUserId: req.viewUserId,
        isImpersonating: !!req.session?.asUserId,
      },
      "HIT /api/me/summary"
    );

    // Only block real admins who are NOT impersonating
    if (req.user?.role === "admin" && !req.session?.asUserId) {
      logger.info("ADMIN SUMMARY -> returning zeros");
      return res.json({
        nextSession: null,
        upcomingCount: 0,
        completedCount: 0,
      });
    }

    await finalizeExpiredSessionsForUser(req.viewUserId);

    const userId = req.viewUserId;

    // When impersonating, get the impersonated user's role
    const isImpersonating = !!req.session?.asUserId;
    let role = req.user.role || "learner";

    if (isImpersonating && req.session.asUserId) {
      const impersonatedUser = await prisma.user.findUnique({
        where: { id: req.session.asUserId },
        select: { role: true },
      });
      if (impersonatedUser) {
        role = impersonatedUser.role;
      }
    }

    const whereBase =
      role === "teacher"
        ? {
          OR: [
            { teacherId: userId },
            { participants: { some: { userId } } },
            { userId },
          ],
        }
        : {
          OR: [{ participants: { some: { userId } } }, { userId }],
        };

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

    const upcomingCount = await prisma.session.count({
      where: {
        AND: [whereBase, { status: { not: "canceled" } }, inProgressOrFuture],
      },
    });

    const completedCount = await prisma.session.count({
      where: { ...whereBase, status: "completed" },
    });

    const nextSession = await prisma.session.findFirst({
      where: {
        AND: [whereBase, { status: { not: "canceled" } }, inProgressOrFuture],
      },
      orderBy: { startAt: "asc" },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        joinUrl: true,
        status: true,
        type: true,
        teacher: { select: { id: true, name: true } },
      },
    });

    return res.json({ nextSession, upcomingCount, completedCount });
  } catch (err) {
    logger.error({ err }, "GET /api/me/summary failed");
    return res.status(500).json({ error: "Failed to load summary" });
  }
});

// --------------------------------------------------------------------------
// Learner: My packages (entitlements)
// GET /api/me/packages
// --------------------------------------------------------------------------
app.get("/api/me/packages", requireAuth, async (req, res) => {
  try {
    // Only block real admins who are NOT impersonating
    if (req.user.role === "admin" && !req.session?.asUserId) {
      return res.json([]);
    }

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

/* ========================================================================== */
/*                                  USERS                                     */
/* ========================================================================== */

app.get(
  "/api/users",
  requireAuth,
  requireAdmin,
  validateRequest({ query: UsersQuerySchema }),
  async (req, res) => {
    const roleRaw = req.query.role;
    const q = req.query.q;
    const active = req.query.active;

    const where = {};

    if (roleRaw) {
      where.role = roleRaw;
    }

    if (active === "1") {
      where.isDisabled = false;
    } else if (active === "0") {
      where.isDisabled = true;
    }

    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }

    const users = await prisma.user.findMany({
      where,
      select: { id: true, email: true, name: true, role: true, timezone: true },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: 200,
    });

    res.json(users);
  }
);

// Get learners specifically (for admin session creation)
app.get(
  "/api/learners",
  requireAuth,
  requireAdmin,
  validateRequest({ query: LearnersQuerySchema }),
  async (req, res) => {
    try {
      const { q, active } = req.query;

      const where = { role: "learner" };

      if (active === "1") {
        where.isDisabled = false;
      }

      if (q) {
        where.OR = [
          { email: { contains: q, mode: "insensitive" } },
          { name: { contains: q, mode: "insensitive" } },
        ];
      }

      const learners = await prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          isDisabled: true,
          timezone: true,
        },
        orderBy: [{ name: "asc" }, { email: "asc" }],
        take: 100,
      });

      res.json(learners);
    } catch (e) {
      console.error("GET /api/learners failed:", e);
      res.status(500).json({ error: "Failed to load learners" });
    }
  }
);

app.get(
  "/api/teachers",
  requireAuth,
  requireAdmin,
  validateRequest({ query: TeachersQuerySchema }),
  async (req, res) => {
    const onlyActive = req.query.active === "1";
    const q = req.query.q;
    const where = { role: "teacher" };

    if (onlyActive) where.isDisabled = false;
    if (q) {
      where.OR = [
        { email: { contains: q, mode: "insensitive" } },
        { name: { contains: q, mode: "insensitive" } },
      ];
    }

    const teachers = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        timezone: true,
      },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      take: 200,
    });
    res.json(teachers);
  }
);

app.post(
  "/api/me/password",
  requireAuth,
  validateRequest({ body: ChangePasswordBodySchema }),
  async (req, res) => {
    try {
      const { currentPassword, newPassword } = req.body;

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { id: true, hashedPassword: true },
      });
      if (!user) return res.status(404).json({ error: "User not found" });

      const ok = await bcrypt.compare(currentPassword, user.hashedPassword);
      if (!ok)
        return res.status(401).json({ error: "Current password is incorrect" });

      const hashedPassword = await bcrypt.hash(newPassword, 10);
      const passwordChangedAt = new Date();
      await prisma.user.update({
        where: { id: user.id },
        data: { hashedPassword, passwordChangedAt },
      });
      req.session.loginAt = passwordChangedAt.getTime();

      res.json({ ok: true });
    } catch (err) {
      console.error("Change password error:", err);
      res.status(500).json({ error: "Failed to change password" });
    }
  }
);

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

  if (err instanceof z.ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      details: formatZodError(err),
    });
  }

  res.status(500).json({ error: "Internal server error" });
});

export default app;
