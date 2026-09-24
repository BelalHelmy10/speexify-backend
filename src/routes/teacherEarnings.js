import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { audit } from "./admin/shared.js";
import {
  getTeacherEarningsSummary,
  isTeacherEarningsUnavailable,
  syncTeacherEarnings,
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

const AdjustmentBodySchema = z.object({
  teacherId: z.coerce.number().int().positive(),
  amountMinor: z.coerce.number().int().refine((value) => value !== 0, "Adjustment cannot be zero"),
  reason: z.string().trim().min(3).max(500),
}).strict();

const PayoutBodySchema = z.object({
  teacherId: z.coerce.number().int().positive(),
  earningIds: z.array(z.coerce.number().int().positive()).max(500).optional().default([]),
  adjustmentIds: z.array(z.coerce.number().int().positive()).max(500).optional().default([]),
  paymentMethod: z.string().trim().min(1).max(40),
  paymentReference: z.string().trim().max(120).optional().nullable(),
  note: z.string().trim().max(500).optional().nullable(),
  paidAt: z.coerce.date().optional(),
}).strict().refine((payload) => payload.earningIds.length + payload.adjustmentIds.length > 0, {
  message: "Select at least one earning or adjustment",
});

async function getTeacherViewUser(req) {
  const user = await prisma.user.findUnique({
    where: { id: Number(req.viewUserId) },
    select: { id: true, role: true },
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

router.get(
  "/teacher/earnings",
  requireAuth,
  validateRequest({ query: EarningsQuerySchema }),
  async (req, res) => {
    try {
      const teacher = await getTeacherViewUser(req);
      if (!teacher) return res.status(403).json({ error: "Teacher earnings only" });

      await syncTeacherEarnings(teacher.id);
      const { status, limit, offset } = req.query;
      const pageLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 50;
      const pageOffset = Number.isInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
      const where = {
        teacherId: teacher.id,
        ...(status ? { status: String(status) } : {}),
      };
      const [entries, total, adjustments, summary] = await Promise.all([
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
        getTeacherEarningsSummary(teacher.id, prisma, { sync: false }),
      ]);

      const shapedEntries = [
        ...entries.map(shapeEntry),
        ...adjustments.map(shapeAdjustment),
      ].sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));

      return res.json({
        currencyCode: TEACHER_EARNINGS_CURRENCY,
        summary,
        entries: shapedEntries,
        total: total + adjustments.length,
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
      if (teacherId) await syncTeacherEarnings(Number(teacherId));

      const where = {
        ...(teacherId ? { teacherId: Number(teacherId) } : {}),
        ...(status ? { status: String(status) } : {}),
      };
      const [entries, total, adjustments, pending, pendingAdjustments, snapshotJobs] = await Promise.all([
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
        total: total + adjustments.length,
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
