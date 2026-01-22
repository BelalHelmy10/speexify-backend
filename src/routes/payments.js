// src/routes/payments.js
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth-helpers.js";
import { logger } from "../lib/logger.js";
import { createPaymentIntention } from "../services/paymobService.js";

const router = Router();

const createIntentSchema = z.object({
  amountCents: z.number().positive(),
  currency: z.string().default("EGP"),
  orderId: z.string(),
  customer: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
  packageId: z.number().optional(),
});

router.post("/create-intent", requireAuth, async (req, res) => {
  try {
    const body = createIntentSchema.parse(req.body);

    const { amountCents, currency, orderId, customer } = body;
    const userId = req.user.id;

    logger.info({ userId, orderId }, "Initiating Paymob Intention");

    const intention = await createPaymentIntention({
      amountCents,
      currency,
      orderId,
      billingData: customer,
    });

    logger.info(
      {
        orderId,
        intentionId: intention.intentionId,
        checkoutUrl: intention.checkoutUrl,
      },
      "Paymob Intention Created",
    );

    return res.json({
      ok: true,
      iframeUrl: intention.checkoutUrl,
      intentionId: intention.intentionId,
    });
  } catch (err) {
    logger.error({ err }, "Create Intent Error");

    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: err.errors });
    }

    // ✅ Show Paymob error details in development only
    if (process.env.NODE_ENV !== "production") {
      return res.status(500).json({
        ok: false,
        message: "Payment init failed",
        debug: {
          status: err?.status,
          message: err?.message,
          paymob: err?.paymob,
        },
      });
    }

    return res.status(500).json({ ok: false, message: "Payment init failed" });
  }
});

router.post("/callback", async (req, res) => {
  try {
    const data = req.body;
    const query = req.query;

    logger.info({ query, body: data }, "Paymob Callback Received");

    // TODO: Verify HMAC here
    return res.json({ received: true });
  } catch (err) {
    logger.error({ err }, "Callback Error");
    return res.status(500).json({ error: "Callback failed" });
  }
});

export default router;
