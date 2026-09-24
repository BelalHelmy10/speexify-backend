import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { audit } from "./admin/shared.js";
import {
  getTeacherEarningsSummary,
  isTeacherEarningsUnavailable,
  validatePayoutEntries,
  TEACHER_EARNINGS_CURRENCY,
} from "../services/teacherEarningsService.js";

const router = Router();

const EarningsQuerySchema = z.object({
  status: z.union([z.literal(""), z.enum(["PENDING", "PAID"]) ]).optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).max(100000).optional().default(0),
});

const AdminEarningsQuerySchema = EarningsQuerySchema.extend({
  teacherId: z.union([z.literal(""), z.coerce.number().int().positive()]).optional().default(""),
});

const PayoutHistoryQuerySchema = z.object({
  teacherId: z.union([z.literal(""), z.coerce.number().int().positive()]).optional().default(""),
  status: z.union([z.literal(""), z.enum(["PAID", "VOIDED", "REVERSED"]) ]).optional().default(""),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).max(100000).optional().default(0),
  format: z.enum(["json", "csv"]).optional().default("json"),
}).superRefine((query, ctx) => {
  if (query.from && query.to && query.from > query.to) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "to must be on or after from" });
  }
});

const AdjustmentBodySchema = z.object({
  teacherId: z.coerce.number().int().positive(),
  amountMinor: z.coerce.number().int().refine((value) => value !== 0, "Adjustment cannot be zero"),
  reason: z.string().trim().min(3).max(500),
}).strict();

const PAYMENT_METHODS = ["bank_transfer", "cash", "wallet", "other"];

const PayoutBodySchema = z.object({
  teacherId: z.coerce.number().int().positive(),
  earningIds: z.array(z.coerce.number().int().positive()).max(500).optional().default([]),
  adjustmentIds: z.array(z.coerce.number().int().positive()).max(500).optional().default([]),
  paymentMethod: z.enum(PAYMENT_METHODS),
  paymentReference: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  paidAt: z.coerce.date().refine(
    (value) => value.getTime() <= Date.now(),
    "paidAt cannot be in the future"
  ).optional(),
}).strict().refine((payload) => payload.earningIds.length + payload.adjustmentIds.length > 0, {
  message: "Select at least one earning or adjustment",
});

const PayoutCorrectionBodySchema = z.object({
  payoutId: z.coerce.number().int().positive(),
  action: z.enum(["VOID", "REVERSE"]),
  reason: z.string().trim().min(3).max(500),
}).strict();

async function getTeacherViewUser(req) {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.viewUserId) },
    select: { id: true, role: true, timezone: true },
  });
  return user?.role === "teacher" ? user : null;
}

function shapeEntry(entry) {
  return {
    id: entry.id,
    entryType: "SESSION",
    adjustmentId: null,
    sessionId: entry.sessionId,
    title: entry.session?.title || "Session",
    startAt: entry.session?.startAt || null,
    endAt: entry.session?.endAt || null,
    durationMinutes: entry.durationMinutes,
    amountMinor: entry.amountMinor,
    currencyCode: entry.currencyCode,
    rateType: entry.rateType,
    rateMinor: entry.rateMinor,
    rateSnapshotAt: entry.rateSnapshotAt,
    rateEffectiveFrom: entry.rateEffectiveFrom,
    rateSnapshotSource: entry.rateSnapshotSource,
    status: entry.status,
    createdAt: entry.createdAt,
    paidAt: entry.paidAt,
    payoutId: entry.payoutId,
  };
}

function shapeAdjustment(adjustment) {
  return {
    id: adjustment.id,
    entryType: "ADJUSTMENT",
    adjustmentId: adjustment.id,
    sessionId: null,
    title: "Manual adjustment",
    reason: adjustment.reason,
    startAt: null,
    endAt: null,
    durationMinutes: null,
    amountMinor: adjustment.amountMinor,
    currencyCode: adjustment.currencyCode,
    rateType: "manual",
    rateMinor: null,
    status: adjustment.status,
    createdAt: adjustment.createdAt,
    paidAt: adjustment.paidAt,
    payoutId: adjustment.payoutId,
  };
}

function shapePayout(payout) {
  return {
    id: payout.id,
    teacherId: payout.teacherId,
    teacher: payout.teacher || null,
    createdBy: payout.createdBy || null,
    totalMinor: payout.totalMinor,
    currencyCode: payout.currencyCode,
    paymentMethod: payout.paymentMethod,
    paymentReference: payout.paymentReference,
    note: payout.note,
    status: payout.status,
    paidAt: payout.paidAt,
    createdAt: payout.createdAt,
    reversal: payout.reversals?.[0] || null,
  };
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function payoutsCsv(items) {
  const headers = ["id", "teacher", "teacherEmail", "recordedBy", "totalMinor", "currency", "paymentMethod", "status", "paidAt", "reference", "reversalAction", "reversalReason"];
  const rows = items.map((item) => [
    item.id,
    item.teacher?.name || "",
    item.teacher?.email || "",
    item.createdBy?.name || item.createdBy?.email || "",
    item.totalMinor,
    item.currencyCode,
    item.paymentMethod,
    item.status,
    item.paidAt,
    item.paymentReference || "",
    item.reversal?.action || "",
    item.reversal?.reason || "",
  ]);
  return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

router.get(
  "/teacher/earnings",
  requireAuth,
  validateRequest({ query: EarningsQuerySchema }),
  async (req, res) => {
    try {
      const teacher = await getTeacherViewUser(req);
      if (!teacher) return res.status(403).json({ error: "Teacher earnings only" });

      const { status, limit, offset } = req.query;
      const pageLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
      const pageOffset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
      const where = {
        teacherId: teacher.id,
        ...(status ? { status: String(status) } : {}),
      };
      const [entries, total, adjustments, adjustmentTotal, summary] = await Promise.all([
        prisma.teacherEarning.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageLimit,
          skip: pageOffset,
          include: {
            session: { select: { title: true, startAt: true, endAt: true } },
          },
        }),
        prisma.teacherEarning.count({ where }),
        prisma.teacherEarningAdjustment.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: pageLimit,
          skip: pageOffset,
        }),
        prisma.teacherEarningAdjustment.count({ where }),
        getTeacherEarningsSummary(teacher.id, prisma, {
          sync: false,
          timezone: teacher.timezone,
        }),
      ]);

      const shapedEntries = [
        ...entries.map(shapeEntry),
        ...adjustments.map(shapeAdjustment),
      ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

      return res.json({
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        summary,
        entries: shapedEntries,
        total: total + adjustmentTotal,
        limit: pageLimit,
        offset: pageOffset,
      });
    } catch (err) {
      if (isTeacherEarningsUnavailable(err)) {
        return res.status(503).json({
          code: "EARNINGS_NOT_READY",
          error: "Teacher earnings are being prepared. Please try again after setup is complete.",
        });
      }
      console.error("GET /api/teacher/earnings failed:", err);
      return res.status(500).json({ error: "Failed to load teacher earnings" });
    }
  }
);

router.get(
  "/admin/teacher-earnings",
  requireAuth,
  requireAdmin,
  validateRequest({ query: AdminEarningsQuerySchema }),
  async (req, res) => {
    try {
      const { teacherId, status, limit, offset } = req.query;
      const pageLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
      const pageOffset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
      const where = {
        ...(teacherId ? { teacherId: Number(teacherId) } : {}),
        ...(status ? { status: String(status) } : {}),
      };
      const [entries, total, adjustments, adjustmentTotal, pending, pendingAdjustments, snapshotJobs] = await Promise.all([
        prisma.teacherEarning.findMany({
          where,
          orderBy: [{ status: "asc" }, { createdAt: "desc" }],
          take: pageLimit,
          skip: pageOffset,
          include: {
            session: { select: { title: true, startAt: true, endAt: true } },
            teacher: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.teacherEarning.count({ where }),
        prisma.teacherEarningAdjustment.findMany({
          where,
          orderBy: [{ status: "asc" }, { createdAt: "desc" }, { id: "desc" }],
          take: pageLimit,
          skip: pageOffset,
          include: {
            teacher: { select: { id: true, name: true, email: true } },
          },
        }),
        prisma.teacherEarningAdjustment.count({ where }),
        prisma.teacherEarning.aggregate({
          where: { ...where, status: "PENDING" },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
        prisma.teacherEarningAdjustment.aggregate({
          where: { ...where, status: "PENDING" },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
        prisma.teacherEarningSnapshotJob.findMany({
          where: {
            ...(teacherId ? { teacherId: Number(teacherId) } : {}),
            status: { in: ["PENDING", "PROCESSING", "FAILED"] },
          },
          orderBy: [{ status: "asc" }, { createdAt: "asc" }],
          take: 100,
          select: {
            id: true,
            sessionId: true,
            teacherId: true,
            status: true,
            attempts: true,
            nextAttemptAt: true,
            lastAttemptAt: true,
            lastError: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ]);

      const shapedEntries = [
        ...entries.map((entry) => ({ ...shapeEntry(entry), teacher: entry.teacher })),
        ...adjustments.map((adjustment) => ({ ...shapeAdjustment(adjustment), teacher: adjustment.teacher })),
      ];

      return res.json({
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        entries: shapedEntries,
        total: total + adjustmentTotal,
        limit: pageLimit,
        offset: pageOffset,
        pendingMinor: (pending._sum.amountMinor || 0) + (pendingAdjustments._sum.amountMinor || 0),
        pendingCount: pending._count._all + pendingAdjustments._count._all,
        snapshotJobs,
      });
    } catch (err) {
      if (isTeacherEarningsUnavailable(err)) {
        return res.status(503).json({
          code: "EARNINGS_NOT_READY",
          error: "Teacher earnings are being prepared. Please try again after setup is complete.",
        });
      }
      console.error("GET /api/admin/teacher-earnings failed:", err);
      return res.status(500).json({ error: "Failed to load teacher earnings" });
    }
  }
);

router.post(
  "/admin/teacher-earnings/adjustments",
  requireAuth,
  requireAdmin,
  validateRequest({ body: AdjustmentBodySchema }),
  async (req, res) => {
    try {
      const { teacherId, amountMinor, reason } = req.body;
      const teacher = await prisma.user.findUnique({
        where: { id: teacherId },
        select: { id: true, role: true },
      });
      if (!teacher || teacher.role !== "teacher") {
        return res.status(404).json({ error: "Teacher not found" });
      }

      const adjustment = await prisma.teacherEarningAdjustment.create({
        data: {
          teacherId,
          createdById: req.user.id,
          amountMinor,
          currencyCode: TEACHER_EARNINGS_CURRENCY,
          reason,
          status: "PENDING",
        },
      });

      await audit(req.user.id, "teacher_earning_adjustment_created", "TeacherEarningAdjustment", adjustment.id, {
        teacherId,
        amountMinor,
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        reason,
      });

      return res.status(201).json({ adjustment });
    } catch (err) {
      if (isTeacherEarningsUnavailable(err)) {
        return res.status(503).json({
          code: "EARNINGS_NOT_READY",
          error: "Teacher earnings are being prepared. Please try again after setup is complete.",
        });
      }
      console.error("POST /api/admin/teacher-earnings/adjustments failed:", err);
      return res.status(500).json({ error: "Failed to create teacher earnings adjustment" });
    }
  }
);

router.post(
  "/admin/teacher-payouts/reversal",
  requireAuth,
  requireAdmin,
  validateRequest({ body: PayoutCorrectionBodySchema }),
  async (req, res) => {
    const payoutId = Number(req.body?.payoutId);
    try {
      if (!Number.isInteger(payoutId) || payoutId <= 0) {
        return res.status(400).json({ error: "Invalid payout id" });
      }
      const { action, reason } = req.body;
      const result = await prisma.$transaction(async (tx) => {
        const payout = await tx.teacherPayout.findUnique({
          where: { id: payoutId },
          select: {
            id: true,
            teacherId: true,
            totalMinor: true,
            currencyCode: true,
            status: true,
            earnings: { select: { id: true, status: true } },
            adjustments: { select: { id: true, status: true } },
          },
        });
        if (!payout) {
          const error = new Error("Payout not found");
          error.code = "PAYOUT_NOT_FOUND";
          throw error;
        }
        if (payout.status !== "PAID") {
          const error = new Error("This payout has already been corrected");
          error.code = "PAYOUT_ALREADY_CORRECTED";
          throw error;
        }

        const reversal = await tx.teacherPayoutReversal.create({
          data: {
            payoutId: payout.id,
            teacherId: payout.teacherId,
            createdById: req.user.id,
            action,
            amountMinor: payout.totalMinor,
            currencyCode: TEACHER_EARNINGS_CURRENCY,
            reason,
          },
        });

        if (action === "VOID") {
          const settledEarnings = await tx.teacherEarning.updateMany({
            where: { payoutId: payout.id, status: "PAID" },
            data: { status: "PENDING", paidAt: null, payoutId: null },
          });
          const settledAdjustments = await tx.teacherEarningAdjustment.updateMany({
            where: { payoutId: payout.id, status: "PAID" },
            data: { status: "PENDING", paidAt: null, payoutId: null },
          });
          if (
            settledEarnings.count !== payout.earnings.length ||
            settledAdjustments.count !== payout.adjustments.length
          ) {
            const error = new Error("Payout entries changed while the correction was being recorded");
            error.code = "PAYOUT_CONFLICT";
            throw error;
          }
        } else {
          await tx.teacherEarningAdjustment.create({
            data: {
              teacherId: payout.teacherId,
              createdById: req.user.id,
              amountMinor: -payout.totalMinor,
              currencyCode: TEACHER_EARNINGS_CURRENCY,
              reason: `Reversal of payout #${payout.id}: ${reason}`,
              status: "PENDING",
            },
          });
        }

        const updatedPayout = await tx.teacherPayout.update({
          where: { id: payout.id, status: "PAID" },
          data: { status: action === "VOID" ? "VOIDED" : "REVERSED" },
        });
        return { payout: updatedPayout, reversal };
      });

      await audit(req.user.id, `teacher_payout_${action.toLowerCase()}`, "TeacherPayout", payoutId, {
        action,
        amountMinor: result.reversal.amountMinor,
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        reason,
      });
      return res.status(201).json(result);
    } catch (err) {
      if (err?.code === "PAYOUT_NOT_FOUND") return res.status(404).json({ error: err.message });
      if (["PAYOUT_ALREADY_CORRECTED", "PAYOUT_CONFLICT", "P2002"].includes(err?.code)) {
        return res.status(409).json({ error: err.message || "Payout correction conflict" });
      }
      if (isTeacherEarningsUnavailable(err)) {
        return res.status(503).json({ code: "EARNINGS_NOT_READY", error: "Payout corrections are not ready until the earnings migration is deployed." });
      }
      console.error("POST /api/admin/teacher-payouts/reversal failed:", err);
      return res.status(500).json({ error: "Failed to correct teacher payout" });
    }
  }
);

router.get(
  "/admin/teacher-payouts",
  requireAuth,
  requireAdmin,
  validateRequest({ query: PayoutHistoryQuerySchema }),
  async (req, res) => {
    try {
      const { teacherId, status, from, to, limit, offset, format } = req.query;
      const pageLimit = format === "csv" ? 5000 : Number(limit);
      const pageOffset = format === "csv" ? 0 : Number(offset);
      const paidAt = {};
      if (from) paidAt.gte = from;
      if (to) paidAt.lt = new Date(new Date(to).getTime() + 24 * 60 * 60 * 1000);
      const where = {
        ...(teacherId ? { teacherId: Number(teacherId) } : {}),
        ...(status ? { status } : {}),
        ...(Object.keys(paidAt).length ? { paidAt } : {}),
      };
      const reconciliationWhere = {
        ...(teacherId ? { teacherId: Number(teacherId) } : {}),
        ...(Object.keys(paidAt).length ? { paidAt } : {}),
      };

      const [payouts, total, statusTotals] = await Promise.all([
        prisma.teacherPayout.findMany({
          where,
          orderBy: [{ paidAt: "desc" }, { id: "desc" }],
          take: pageLimit,
          skip: pageOffset,
          include: {
            teacher: { select: { id: true, name: true, email: true } },
            createdBy: { select: { id: true, name: true, email: true } },
            reversals: { orderBy: { createdAt: "desc" }, take: 1 },
          },
        }),
        prisma.teacherPayout.count({ where }),
        prisma.teacherPayout.groupBy({
          by: ["status"],
          where: reconciliationWhere,
          _sum: { totalMinor: true },
          _count: { _all: true },
        }),
      ]);

      const items = payouts.map(shapePayout);
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="speexify-payout-history-${new Date().toISOString().slice(0, 10)}.csv"`);
        return res.send(payoutsCsv(items));
      }

      return res.json({
        items,
        total,
        limit: Number(limit),
        offset: Number(offset),
        reconciliation: Object.fromEntries(statusTotals.map((row) => [
          row.status,
          { count: row._count._all, totalMinor: row._sum.totalMinor || 0 },
        ])),
      });
    } catch (err) {
      if (isTeacherEarningsUnavailable(err)) {
        return res.status(503).json({ code: "EARNINGS_NOT_READY", error: "Payout history is not ready until the earnings migration is deployed." });
      }
      console.error("GET /api/admin/teacher-payouts failed:", err);
      return res.status(500).json({ error: "Failed to load payout history" });
    }
  }
);

router.post(
  "/admin/teacher-payouts",
  requireAuth,
  requireAdmin,
  validateRequest({ body: PayoutBodySchema }),
  async (req, res) => {
    try {
      const { teacherId, earningIds, adjustmentIds, paymentMethod, paymentReference, note, paidAt } = req.body;
      const teacher = await prisma.user.findUnique({ where: { id: teacherId }, select: { id: true, role: true } });
      if (!teacher || teacher.role !== "teacher") return res.status(404).json({ error: "Teacher not found" });

      const payout = await prisma.$transaction(async (tx) => {
        const entries = await tx.teacherEarning.findMany({
          where: { id: { in: earningIds }, teacherId, status: "PENDING", currencyCode: TEACHER_EARNINGS_CURRENCY },
          select: { id: true, amountMinor: true },
        });
        const totalEarningMinor = validatePayoutEntries(earningIds, entries);
        const adjustments = await tx.teacherEarningAdjustment.findMany({
          where: {
            id: { in: adjustmentIds },
            teacherId,
            status: "PENDING",
            currencyCode: TEACHER_EARNINGS_CURRENCY,
          },
          select: { id: true, amountMinor: true },
        });
        if (new Set(adjustmentIds).size !== adjustmentIds.length || adjustments.length !== adjustmentIds.length) {
          const error = new Error("Some adjustments are missing or already paid");
          error.code = "INVALID_EARNINGS";
          throw error;
        }
        const totalMinor = totalEarningMinor + adjustments.reduce((sum, adjustment) => sum + adjustment.amountMinor, 0);
        if (totalMinor <= 0) {
          const error = new Error("The selected payout total must be greater than zero");
          error.code = "INVALID_EARNINGS";
          throw error;
        }
        const created = await tx.teacherPayout.create({
          data: {
            teacherId,
            createdById: req.user.id,
            totalMinor,
            currencyCode: TEACHER_EARNINGS_CURRENCY,
            paymentMethod,
            paymentReference: paymentReference || null,
            note: note || null,
            ...(paidAt ? { paidAt } : {}),
          },
        });
        const settled = await tx.teacherEarning.updateMany({
          where: { id: { in: earningIds }, teacherId, status: "PENDING" },
          data: { status: "PAID", paidAt: created.paidAt, payoutId: created.id },
        });
        if (settled.count !== entries.length) {
          const error = new Error("Some earnings were settled by another payout");
          error.code = "INVALID_EARNINGS";
          throw error;
        }
        const settledAdjustments = await tx.teacherEarningAdjustment.updateMany({
          where: { id: { in: adjustmentIds }, teacherId, status: "PENDING" },
          data: { status: "PAID", paidAt: created.paidAt, payoutId: created.id },
        });
        if (settledAdjustments.count !== adjustments.length) {
          const error = new Error("Some adjustments were settled by another payout");
          error.code = "INVALID_EARNINGS";
          throw error;
        }
        return { ...created, earningCount: entries.length, adjustmentCount: adjustments.length };
      });

      await audit(req.user.id, "teacher_payout_created", "TeacherPayout", payout.id, {
        teacherId,
        totalMinor: payout.totalMinor,
        earningCount: payout.earningCount,
        adjustmentCount: payout.adjustmentCount,
        currencyCode: TEACHER_EARNINGS_CURRENCY,
      });

      return res.status(201).json({ payout });
    } catch (err) {
      if (err?.code === "INVALID_EARNINGS") return res.status(409).json({ error: err.message });
      if (err?.code === "RATE_NOT_CONFIGURED") return res.status(422).json({ error: err.message });
      console.error("POST /api/admin/teacher-payouts failed:", err);
      return res.status(500).json({ error: "Failed to record teacher payout" });
    }
  }
);

export default router;
