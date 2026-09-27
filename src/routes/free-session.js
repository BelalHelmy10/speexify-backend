import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { enqueueEmail } from "../services/emailService.js";
import { requireAdmin, requireAuth } from "../middleware/auth-helpers.js";
import { contactEmailLimiter, contactIpLimiter } from "../middleware/rateLimit.js";
import { formatZodError } from "../middleware/validateRequest.js";

const router = Router();

const GOALS = ["work", "travel", "conversation", "interviews", "exams", "other"];
const DAY_VALUES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const TIME_VALUES = ["morning", "afternoon", "evening"];
const AVAILABILITY_HOURS = Array.from({ length: 17 }, (_, index) => index + 8);
const AVAILABILITY_SLOT_VALUES = new Set(DAY_VALUES.flatMap((day) => AVAILABILITY_HOURS.map((hour) => `${day} ${String(hour).padStart(2, "0")}:00`)));
const STATUS_VALUES = ["NEW", "CONTACTED", "BOOKED", "CLOSED"];

const FreeSessionRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(8).max(40),
    email: z.union([z.string().trim().email(), z.literal("")]).optional().default(""),
    locale: z.enum(["en", "ar"]).default("en"),
    goal: z.enum(GOALS),
    availabilitySlots: z.array(z.string().refine((value) => AVAILABILITY_SLOT_VALUES.has(value), "Invalid availability slot")).max(AVAILABILITY_SLOT_VALUES.size).optional().default([]),
    preferredDays: z.array(z.enum(DAY_VALUES)).min(1).max(7).optional(),
    preferredTimes: z.array(z.enum(TIME_VALUES)).min(1).max(3).optional(),
    notes: z.string().trim().max(1200).optional().default(""),
  })
  .strict()
  .refine((data) => data.availabilitySlots.length || (data.preferredDays?.length && data.preferredTimes?.length), {
    path: ["availabilitySlots"],
    message: "Choose at least one availability hour",
  });

const AdminQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  status: z.enum(["", ...STATUS_VALUES]).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const AdminStatusSchema = z.object({
  status: z.enum(STATUS_VALUES),
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function display(value, fallback = "—") {
  const text = String(value ?? "").trim();
  return text ? escapeHtml(text) : fallback;
}

function adminUrl() {
  const base = process.env.ADMIN_APP_URL || process.env.FRONTEND_URL || "https://speexify.com";
  try {
    return new URL("/admin/free-sessions", base).toString();
  } catch {
    return "https://speexify.com/admin/free-sessions";
  }
}

function slotLabel(slot, locale = "en") {
  const labels = {
    weekday_morning: { en: "Weekdays · Morning", ar: "أيام الأسبوع · الصبح" },
    weekday_afternoon: { en: "Weekdays · Afternoon", ar: "أيام الأسبوع · بعد الظهر" },
    weekday_evening: { en: "Weekdays · Evening", ar: "أيام الأسبوع · بالليل" },
    weekend_morning: { en: "Weekend · Morning", ar: "الويك إند · الصبح" },
    weekend_afternoon: { en: "Weekend · Afternoon", ar: "الويك إند · بعد الظهر" },
    weekend_evening: { en: "Weekend · Evening", ar: "الويك إند · بالليل" },
  };
  return labels[slot]?.[locale] || slot;
}

function dayLabel(day, locale = "en") {
  const labels = {
    sunday: { en: "Sunday", ar: "الأحد" },
    monday: { en: "Monday", ar: "الاثنين" },
    tuesday: { en: "Tuesday", ar: "الثلاثاء" },
    wednesday: { en: "Wednesday", ar: "الأربعاء" },
    thursday: { en: "Thursday", ar: "الخميس" },
    friday: { en: "Friday", ar: "الجمعة" },
    saturday: { en: "Saturday", ar: "السبت" },
  };
  return labels[day]?.[locale] || day;
}

function timeLabel(time, locale = "en") {
  const labels = {
    morning: { en: "Morning · 9 am – 12 pm", ar: "الصبح · من ٩ الصبح لـ ١٢ الضهر" },
    afternoon: { en: "Afternoon · 12 pm – 5 pm", ar: "بعد الظهر · من ١٢ الضهر لـ ٥ العصر" },
    evening: { en: "Evening · 5 pm – 10 pm", ar: "بالليل · من ٥ العصر لـ ١٠ بالليل" },
  };
  return labels[time]?.[locale] || time;
}

function availabilityHourLabel(hour, locale = "en") {
  const numericHour = Number(hour);
  const normalized = numericHour === 24 ? 0 : numericHour;
  const display = normalized % 12 || 12;
  const suffix = locale === "ar" ? (normalized < 12 ? "ص" : "م") : (normalized < 12 ? "AM" : "PM");
  return `${display} ${suffix}`;
}

function availabilityGroups(slots, locale = "en") {
  const groups = new Map();
  for (const slot of Array.isArray(slots) ? slots : []) {
    const match = String(slot).match(/^([a-z]+) (\d{2}):00$/);
    if (!match) continue;
    const [, day, hour] = match;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(availabilityHourLabel(Number(hour), locale));
  }
  return [...groups.entries()].map(([day, hours]) => `${dayLabel(day, locale)}: ${hours.join(", ")}`);
}

function goalLabel(goal, locale = "en") {
  const labels = {
    work: { en: "Work and career", ar: "الشغل والتطور المهني" },
    travel: { en: "Travel", ar: "السفر" },
    conversation: { en: "Everyday conversation", ar: "الكلام اليومي" },
    interviews: { en: "Interviews", ar: "الإنترفيوهات" },
    exams: { en: "Exams", ar: "الامتحانات" },
    other: { en: "Something else", ar: "حاجة تانية" },
  };
  return labels[goal]?.[locale] || goal;
}

function requestEmailHtml(request) {
  const locale = request.locale === "ar" ? "ar" : "en";
  const availability = availabilityGroups(request.availabilitySlots, locale);
  const days = Array.isArray(request.preferredDays) ? request.preferredDays : [];
  const times = Array.isArray(request.preferredTimes) ? request.preferredTimes : [];
  const legacySlots = Array.isArray(request.preferredSlots) ? request.preferredSlots : [];
  const subjectCopy = locale === "ar" ? "طلب جلسة مجانية جديد" : "New free session request";
  const intro = locale === "ar"
    ? "في حد جديد طلب أول جلسة مجانية مع Speexify."
    : "Someone just requested their first free Speexify session.";

  return `
    <div style="font-family:Arial,sans-serif;max-width:620px;color:#0d1b2a;line-height:1.6">
      <div style="border-radius:18px;background:#fdf0eb;padding:24px 28px;margin-bottom:22px">
        <div style="font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#d94b1f">Speexify</div>
        <h2 style="margin:8px 0 4px;font-size:26px">${escapeHtml(subjectCopy)}</h2>
        <p style="margin:0;color:#5a6a7a">${escapeHtml(intro)}</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        <tr><td style="padding:9px 0;color:#5a6a7a;width:170px">Name</td><td style="padding:9px 0;font-weight:700">${display(request.name)}</td></tr>
        <tr><td style="padding:9px 0;color:#5a6a7a">Phone / WhatsApp</td><td style="padding:9px 0;font-weight:700">${display(request.phone)}</td></tr>
        <tr><td style="padding:9px 0;color:#5a6a7a">Email</td><td style="padding:9px 0">${display(request.email)}</td></tr>
        <tr><td style="padding:9px 0;color:#5a6a7a">Goal</td><td style="padding:9px 0">${escapeHtml(goalLabel(request.goal, locale))}</td></tr>
        <tr><td style="padding:9px 0;color:#5a6a7a">Availability</td><td style="padding:9px 0">${(availability.length ? availability : days.length ? [days.map((day) => dayLabel(day, locale)).join(", "), ...times.map((time) => timeLabel(time, locale))] : legacySlots.map((slot) => slotLabel(slot, locale))).map((item) => escapeHtml(item)).join("<br />") || "—"}</td></tr>
      </table>
      ${request.notes ? `<div style="margin-top:16px;padding:14px 16px;border-left:3px solid #f25c2e;background:#f8f6f2"><strong>Note</strong><br />${escapeHtml(request.notes)}</div>` : ""}
      <a href="${escapeHtml(adminUrl())}" style="display:inline-block;margin-top:24px;background:#f25c2e;color:#fff;text-decoration:none;font-weight:700;padding:13px 18px;border-radius:10px">Open admin queue →</a>
    </div>
  `;
}

router.post(
  "/free-session-requests",
  contactIpLimiter,
  contactEmailLimiter,
  async (req, res) => {
    const parsed = FreeSessionRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: "Validation failed",
        details: formatZodError(parsed.error, "body"),
      });
    }

    const data = parsed.data;
    const request = await prisma.freeSessionRequest.create({ data });

    let emailQueued = false;
    try {
      await enqueueEmail(
        process.env.ADMIN_NOTIFICATION_EMAIL || "support@speexify.com",
        `[Free session] ${data.name}`,
        requestEmailHtml(request),
        { eventType: "free_session_request", locale: data.locale }
      );
      emailQueued = true;
    } catch (error) {
      logger.error({ err: error, requestId: request.id }, "Free-session admin email could not be queued");
    }

    return res.status(201).json({ ok: true, requestId: request.id, emailQueued });
  }
);

router.get("/admin/free-session-requests", requireAuth, requireAdmin, async (req, res) => {
  const parsed = AdminQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Validation failed", details: formatZodError(parsed.error, "query") });
  }

  const { q, status, limit, offset } = parsed.data;
  const where = {
    ...(status ? { status } : {}),
    ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { phone: { contains: q } }, { email: { contains: q, mode: "insensitive" } }] } : {}),
  };
  const [items, total, counts] = await Promise.all([
    prisma.freeSessionRequest.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
    prisma.freeSessionRequest.count({ where }),
    prisma.freeSessionRequest.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  return res.json({ items, total, counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])) });
});

router.patch("/admin/free-session-requests/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = AdminStatusSchema.safeParse(req.body);
  if (!Number.isInteger(id) || id <= 0 || !parsed.success) {
    return res.status(400).json({ error: "Invalid request" });
  }
  const item = await prisma.freeSessionRequest.update({ where: { id }, data: { status: parsed.data.status } });
  return res.json({ item });
});

export default router;
