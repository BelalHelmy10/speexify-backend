import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { validateRequest } from "../../middleware/validateRequest.js";
import { logger } from "../../lib/logger.js";
import {
  getPaymobAdminPayments,
  getPaymobAdminPaymentDetail,
} from "../../services/paymentReconciliationService.js";

const router = Router();

const DateQueryValue = z
  .string()
  .trim()
  .refine((value) => !value || !Number.isNaN(new Date(value).getTime()), "Invalid date");

const PaymentsQuerySchema = z.object({
  status: z.enum(["all", "paid", "pending", "failed"]).default("all"),
  q: z.string().trim().max(120).optional().default(""),
  packageId: z.coerce.number().int().positive().optional(),
  from: DateQueryValue.optional().default(""),
  to: DateQueryValue.optional().default(""),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  offset: z.coerce.number().int().min(0).max(1000000).optional().default(0),
});

const PaymentIdParamsSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
});

router.get(
  "/admin/payments",
  requireAuth,
  requireAdmin,
  validateRequest({ query: PaymentsQuerySchema }),
  async (req, res) => {
    try {
      const data = await getPaymobAdminPayments({
        status: req.query.status,
        search: req.query.q,
        packageId: req.query.packageId,
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
        offset: req.query.offset,
      });

      return res.json(data);
    } catch (err) {
      logger.error({ err, adminId: req.user?.id }, "admin.payments.list error");
      return res.status(500).json({ error: "Failed to load payment operations" });
    }
  }
);

router.get(
  "/admin/payments/:orderId",
  requireAuth,
  requireAdmin,
  validateRequest({ params: PaymentIdParamsSchema }),
  async (req, res) => {
    try {
      const payment = await getPaymobAdminPaymentDetail(req.params.orderId);
      if (!payment) {
        return res.status(404).json({ error: "Payment not found" });
      }

      return res.json(payment);
    } catch (err) {
      logger.error(
        { err, adminId: req.user?.id, orderId: req.params.orderId },
        "admin.payments.detail error"
      );
      return res.status(500).json({ error: "Failed to load payment details" });
    }
  }
);

export default router;
