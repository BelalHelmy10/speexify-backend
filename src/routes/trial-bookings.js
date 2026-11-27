import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAdmin, requireAuth } from "../middleware/auth-helpers.js";
import { createRedisRateLimiter } from "../services/rateLimitService.js";
import { notifyAdmins, ADMIN_ALERT_TYPES } from "../services/adminAlertsService.js";
import { enqueueEmail } from "../services/emailService.js";
import { logger } from "../lib/logger.js";
import { settings, mutateTrial, reserveTrial, changeTrial, findManaged, publicBooking, generateSlots, fail, updateAdminBooking, editTrialSlot } from "../services/trialBookings.js";

const router = Router();
const token = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.number().int().positive();
const timezone = z.string().max(80).refine((v) => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } });
const configSchema = z.object({ leadHours: z.number().int().min(0).max(168), horizonDays: z.number().int().min(1).max(90), durationMin: z.number().int().min(15).max(120), bufferMin: z.number().int().min(0).max(60) }).strict();
const bookingSchema = z.object({ token, slotId: id, name: z.string().trim().min(2).max(120), phone: z.string().regex(/^\+[1-9]\d{7,14}$/), locale: z.enum(["en", "ar"]), timezone, website: z.string().max(0).optional() }).strict();
const generateSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), durationMin: configSchema.shape.durationMin, bufferMin: configSchema.shape.bufferMin, capacity: z.number().int().min(1).max(100) }).strict();
const readLimiter = createRedisRateLimiter({ scope: "trial-read", windowMs: 60000, limit: 100, keyBuilder: (req) => req.ip || "unknown", message: { code: "RATE_LIMITED" } });
const writeLimiter = createRedisRateLimiter({ scope: "trial-write", windowMs: 15 * 60000, limit: 15, keyBuilder: (req) => req.ip || "unknown", message: { code: "RATE_LIMITED" } });
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) fail("INVALID_INPUT", 400); return result.data; };
const noStore = (_req, res, next) => { res.set("Cache-Control", "private, no-store"); next(); };
router.use(["/trial-bookings", "/admin/trial-bookings"], noStore);

async function notify(booking, action) {
  const when = new Date(booking.slot.startAt).toLocaleString("en-GB", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });
  const body = `${booking.name} · ${booking.phone} · ${when} (Cairo) · ${action}`;
  const results = await Promise.allSettled([
    notifyAdmins({ type: ADMIN_ALERT_TYPES.LEAD, title: `Trial ${action}`, body, adminPath: "/admin/free-sessions?tab=bookings", data: { trialBookingId: booking.id }, email: "none" }),
    enqueueEmail(process.env.ADMIN_NOTIFICATION_EMAIL || "support@speexify.com", `Trial ${action}`, `<p>${body.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}</p><p>Open the Trial bookings tab in your Speexify admin dashboard.</p>`, { eventType: `trial_${action}`, locale: booking.locale }),
  ]);
  for (const result of results) if (result.status === "rejected") logger.error({ err: result.reason, bookingId: booking.id }, "Trial notification failed; booking remains saved");
}

router.get("/trial-bookings/availability", readLimiter, async (_req, res) => {
  const config = await settings();
  const now = Date.now();
  const slots = await prisma.trialSlot.findMany({ where: { enabled: true, startAt: { gte: new Date(now + config.leadHours * 3600000), lte: new Date(now + config.horizonDays * 86400000) } }, orderBy: { startAt: "asc" }, take: 10000 });
  res.json({ settings: config, slots: slots.filter((s) => s.reservedCount < s.capacity).map((s) => ({ id: s.id, startAt: s.startAt, endAt: s.endAt })) });
});
router.post("/trial-bookings", writeLimiter, async (req, res) => {
  const result = await reserveTrial(parse(bookingSchema, req.body));
  if (result.created) await notify(result.booking, "reserved");
  res.status(result.created ? 201 : 200).json(result.booking);
});
router.post("/trial-bookings/lookup", readLimiter, async (req, res) => {
  const input = parse(z.object({ token }).strict(), req.body);
  res.json(publicBooking(await findManaged(prisma, input.token)));
});
router.post("/trial-bookings/change", writeLimiter, async (req, res) => {
  const input = parse(z.discriminatedUnion("action", [z.object({ token, action: z.literal("cancel") }).strict(), z.object({ token, action: z.literal("reschedule"), slotId: id }).strict()]), req.body);
  const booking = await changeTrial(input);
  await notify(booking, input.action === "cancel" ? "cancelled" : "rescheduled");
  res.json(booking);
});
router.use("/admin/trial-bookings", requireAuth, requireAdmin);
router.get("/admin/trial-bookings", async (req, res) => {
  const query = parse(z.object({ q: z.string().max(120).default(""), status: z.enum(["", "RESERVED", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]).default(""), from: z.string().datetime().optional(), to: z.string().datetime().optional(), page: z.coerce.number().int().min(0).max(100000).default(0), export: z.enum(["1"]).optional() }), req.query);
  const where = { ...(query.status ? { status: query.status } : {}), ...(query.q ? { OR: [{ name: { contains: query.q, mode: "insensitive" } }, { phone: { contains: query.q } }] } : {}), ...((query.from || query.to) ? { slot: { startAt: { ...(query.from ? { gte: new Date(query.from) } : {}), ...(query.to ? { lt: new Date(query.to) } : {}) } } } : {}) };
  const [items, total] = await Promise.all([
    prisma.trialBooking.findMany({ where, orderBy: [{ slot: { startAt: "asc" } }, { createdAt: "asc" }], skip: query.export ? 0 : query.page * 30, take: query.export ? 10000 : 30, omit: { tokenHash: true }, include: { slot: true, trainer: { select: { id: true, name: true } } } }),
    prisma.trialBooking.count({ where }),
  ]);
  if (query.export) {
    if (total > 10000) fail("EXPORT_TOO_LARGE", 400);
    // Prefix formula-like values, including international phone numbers.
    const cell = (value) => `"${String(value ?? "").replace(/^[\s]*[=+@-]/, (s) => `'${s}`).replaceAll('"', '""')}"`;
    const rows = [["Reference", "Date/time (Cairo)", "Name", "Phone", "Trainer", "Status", "Notes"], ...items.map((b) => [b.id, b.slot.startAt.toLocaleString("en-GB", { timeZone: "Africa/Cairo" }), b.name, b.phone, b.trainer?.name || "", b.status, b.notes])];
    return res.type("text/csv").attachment("trial-bookings.csv").send("\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n"));
  }
  res.json({ items, total });
});
router.get("/admin/trial-bookings/setup", async (_req, res) => {
  const [config, slots, trainers] = await Promise.all([settings(), prisma.trialSlot.findMany({ where: { startAt: { gte: new Date(Date.now() - 86400000), lte: new Date(Date.now() + 90 * 86400000) } }, orderBy: { startAt: "asc" }, take: 10000 }), prisma.user.findMany({ where: { role: "teacher", isDisabled: false }, select: { id: true, name: true }, orderBy: { name: "asc" } })]);
  res.json({ settings: config, slots, trainers });
});
router.put("/admin/trial-bookings/settings", async (req, res) => {
  const data = parse(configSchema, req.body);
  res.json(await mutateTrial((tx) => tx.trialBookingSettings.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } })));
});
router.post("/admin/trial-bookings/slots", async (req, res) => {
  const input = parse(generateSchema, req.body);
  const slots = generateSlots(input);
  if (slots.at(-1).startAt > new Date(Date.now() + 90 * 86400000)) fail("INVALID_DATE", 400);
  await mutateTrial(async (tx) => {
    for (const slot of slots) {
      const existing = await tx.trialSlot.findUnique({ where: { startAt: slot.startAt } });
      if (existing && (existing.endAt.getTime() !== slot.endAt.getTime() || existing.bufferMin !== slot.bufferMin)) fail("SLOT_DURATION_CONFLICT");
      if (existing && existing.capacity + slot.capacity > 100) fail("CAPACITY_LIMIT");
      await tx.trialSlot.upsert({ where: { startAt: slot.startAt }, create: slot, update: { capacity: { increment: slot.capacity }, enabled: true } });
    }
  });
  res.status(201).json({ added: slots.length });
});
router.post("/admin/trial-bookings/copy-day", async (req, res) => {
  const input = parse(z.object({ source: generateSchema.shape.date, target: generateSchema.shape.date }).strict(), req.body);
  if (input.source === input.target) fail("INVALID_DATE", 400);
  const { localToInstant } = await import("../services/trialBookings.js");
  const start = new Date(localToInstant(input.source, "12:00").getTime() - 14 * 3600000);
  const end = new Date(start.getTime() + 28 * 3600000);
  const fmtDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
  const fmtTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const added = await mutateTrial(async (tx) => {
    const source = (await tx.trialSlot.findMany({ where: { startAt: { gte: start, lt: end }, enabled: true } })).filter((s) => fmtDate.format(s.startAt) === input.source);
    if (!source.length) fail("NO_SOURCE_SLOTS", 400);
    for (const s of source) {
      const at = localToInstant(input.target, fmtTime.format(s.startAt));
      if (at <= new Date() || at > new Date(Date.now() + 90 * 86400000)) fail("INVALID_DATE", 400);
      if (await tx.trialSlot.findUnique({ where: { startAt: at } })) fail("TARGET_DAY_CONFLICT");
      await tx.trialSlot.create({ data: { startAt: at, endAt: new Date(at.getTime() + s.endAt.getTime() - s.startAt.getTime()), capacity: s.capacity, bufferMin: s.bufferMin } });
    }
    return source.length;
  });
  res.json({ added });
});
router.patch("/admin/trial-bookings/slots/:id", async (req, res) => {
  const slotId = parse(id, Number(req.params.id));
  const data = parse(z.object({
    capacity: z.number().int().min(1).max(100).optional(), enabled: z.boolean().optional(),
    acknowledgeBookings: z.boolean().optional(),
    schedule: z.object({ date: generateSchema.shape.date, startTime: generateSchema.shape.startTime, durationMin: configSchema.shape.durationMin, bufferMin: configSchema.shape.bufferMin }).strict().optional(),
  }).strict(), req.body);
  const result = await editTrialSlot(slotId, data);
  res.json(result);
});
router.patch("/admin/trial-bookings/:id", async (req, res) => {
  const bookingId = parse(z.string().uuid(), req.params.id);
  const data = parse(z.object({ status: z.enum(["RESERVED", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(), trainerId: id.nullable().optional(), notes: z.string().max(2000).optional() }).strict(), req.body);
  const row = await updateAdminBooking(bookingId, data);
  const { tokenHash: _hash, ...safe } = row;
  res.json(safe);
});
router.use((error, _req, res, next) => {
  if (!error.code || !error.status) return next(error);
  res.status(error.status).json({ code: error.code });
});
export default router;
