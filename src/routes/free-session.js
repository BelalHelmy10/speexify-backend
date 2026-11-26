import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAdmin, requireAuth } from "../middleware/auth-helpers.js";
import { contactEmailLimiter, contactIpLimiter } from "../middleware/rateLimit.js";
import { formatZodError } from "../middleware/validateRequest.js";
import { normalizePhone } from "../lib/phone.js";
import {
  AccountFreeSessionRequestSchema,
  FreeSessionRequestSchema,
  notifyFreeSessionRequest,
} from "../services/freeSessionRequests.js";

const router = Router();

const STATUS_VALUES = ["NEW", "CONTACTED", "BOOKED", "CLOSED"];

const AdminQuerySchema = z.object({
  q: z.string().trim().max(120).optional().default(""),
  status: z.enum(["", ...STATUS_VALUES]).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const AdminStatusSchema = z.object({
  status: z.enum(STATUS_VALUES),
});

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

    const emailQueued = await notifyFreeSessionRequest(request);

    return res.status(201).json({ ok: true, requestId: request.id, emailQueued });
  }
);

router.post("/free-session-requests/account", requireAuth, async (req, res) => {
  if (req.session.asUserId) {
    return res.status(403).json({ error: "Trial requests require your own account" });
  }

  const userId = req.user.id;
  const parsed = AccountFreeSessionRequestSchema.safeParse({ ...req.body, email: req.user.email });
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: formatZodError(parsed.error, "body"),
    });
  }

  let request;
  try {
    request = await prisma.freeSessionRequest.create({
      data: { ...parsed.data, phone: normalizePhone(parsed.data.phone), userId },
    });
  } catch (error) {
    if (error.code !== "P2002") throw error;
    const existing = await prisma.freeSessionRequest.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!existing) throw error;
    return res.json({ ok: true, requestId: existing.id, alreadyRequested: true });
  }

  await notifyFreeSessionRequest(request);
  return res.status(201).json({ ok: true, requestId: request.id });
});

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
