// src/routes/payments.js
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth-helpers.js";
import { logger } from "../lib/logger.js";
import { createPaymentIntention } from "../services/paymobService.js";

const router = Router();

// Schema for validating the payment request
const createIntentSchema = z.object({
  amountCents: z.number().positive(),
  currency: z.string().default("EGP"),
  orderId: z.string(),
  // We expect billing data from frontend or we can pull it from user profile if needed
  customer: z.object({
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    phone: z.string().optional(),
  }),
  packageId: z.number().optional(), // Just for our tracking
});

// POST /api/payments/create-intent
router.post("/create-intent", requireAuth, async (req, res) => {
  try {
    // 1. Validate Input
    const body = createIntentSchema.parse(req.body);

    const { amountCents, currency, orderId, customer } = body;
    const userId = req.user.id;

    logger.info({ userId, orderId }, "Initiating Paymob Intention");

    // 2. Call Paymob Service
    const intention = await createPaymentIntention({
      amountCents,
      currency,
      orderId,
      billingData: customer,
    });

    // 3. Return the Redirect URL to Frontend
    return res.json({
      ok: true,
      iframeUrl: intention.checkoutUrl, // Keeping "iframeUrl" name for compatibility if frontend expects it, or just use checkoutUrl
      intentionId: intention.intentionId,
    });
  } catch (err) {
    logger.error({ err }, "Create Intent Error");
    // Handle Zod validation errors nicely
    if (err instanceof z.ZodError) {
      return res.status(400).json({ ok: false, error: err.errors });
    }
    return res.status(500).json({ ok: false, message: "Payment init failed" });
  }
});

// POST /api/payments/callback
// Paymob will call this URL to notify us of success/failure
router.post("/callback", async (req, res) => {
  try {
    const data = req.body;
    const query = req.query;

    logger.info({ query, body: data }, "Paymob Callback Received");

    // TODO: Verify HMAC here to ensure authenticity
    // TODO: Update order status in database based on 'success' flag

    // We just acknowledge for now
    return res.json({ received: true });
  } catch (err) {
    logger.error({ err }, "Callback Error");
    return res.status(500).json({ error: "Callback failed" });
  }
});

export default router;
