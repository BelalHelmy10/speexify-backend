// src/routes/payments.js
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth-helpers.js";
import { logger } from "../lib/logger.js";
import {
  createPaymentIntention,
  verifyWebhookHMAC,
  parseTransactionCallback,
} from "../services/paymobService.js";
import {
  createPendingOrder,
  markOrderPaid,
  markOrderFailed,
  getOrderById,
  orderExists,
} from "../services/orderService.js";
import { convertToEGP } from "../services/currencyService.js";
import { prisma } from "../lib/prisma.js";

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
  packageId: z.number(),
  discountCode: z.string().optional().nullable(),
});

/**
 * POST /create-intent
 * Creates a pending Order record, then initiates Paymob payment intention
 */
router.post("/create-intent", requireAuth, async (req, res) => {
  try {
    const body = createIntentSchema.parse(req.body);
    const { amountCents, currency, orderId, customer, packageId, discountCode } = body;
    const userId = req.user.id;

    logger.info({ userId, orderId, packageId }, "Initiating payment intent");

    // Check if order already exists (idempotency)
    if (await orderExists(orderId)) {
      logger.warn({ orderId }, "Order already exists, returning existing");
      const existingOrder = await getOrderById(orderId);

      // If order is already paid, don't allow re-payment
      if (existingOrder?.status === "paid") {
        return res.status(400).json({
          ok: false,
          message: "This order has already been paid",
        });
      }
    }

    // Look up discount code ID if provided
    let discountCodeId = null;
    if (discountCode) {
      const discount = await prisma.discountCode.findUnique({
        where: { code: discountCode },
      });
      if (discount) {
        discountCodeId = discount.id;
      }
    }

    // Convert display currency to EGP for Paymob (Paymob integration only supports EGP)
    let egpAmountCents = amountCents;
    let exchangeRate = 1;

    if (currency !== "EGP") {
      // Frontend sends amount in display currency cents, convert to EGP cents
      const displayAmount = amountCents / 100; // Convert cents to whole units
      const conversion = await convertToEGP(displayAmount, currency);
      egpAmountCents = conversion.egpAmount * 100; // Convert back to cents
      exchangeRate = conversion.rate;

      logger.info(
        {
          orderId,
          displayCurrency: currency,
          displayAmountCents: amountCents,
          egpAmountCents,
          exchangeRate,
        },
        "Converted display currency to EGP"
      );
    }

    // Create pending order in database BEFORE calling Paymob
    // Store both display amount and EGP amount for audit
    await createPendingOrder({
      orderId,
      userId,
      packageId,
      amountCents: egpAmountCents, // Store EGP amount (what Paymob charges)
      currency: "EGP", // Always EGP in our system
      displayAmountCents: amountCents, // Original display amount
      displayCurrency: currency, // Original display currency
      customerEmail: customer.email,
      customerPhone: customer.phone,
      discountCodeId,
    });

    // Create Paymob payment intention (ALWAYS in EGP)
    const intention = await createPaymentIntention({
      amountCents: egpAmountCents,
      currency: "EGP", // Always EGP for Paymob
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

    // Show Paymob error details in development only
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

/**
 * POST /webhook
 * Paymob callback/webhook handler
 * Verifies HMAC, updates order status, grants credits on success
 */
router.post("/webhook", async (req, res) => {
  try {
    const hmac = req.query.hmac;
    const body = req.body;

    logger.info(
      { hasHmac: !!hmac, hasBody: !!body },
      "Paymob Webhook Received"
    );

    // 1. Verify HMAC signature
    if (!verifyWebhookHMAC(body, hmac)) {
      logger.warn({ hmac }, "Webhook HMAC verification failed");
      return res.status(401).json({ error: "Invalid HMAC signature" });
    }

    // 2. Parse transaction data
    const txn = parseTransactionCallback(body);

    logger.info(
      {
        transactionId: txn.transactionId,
        success: txn.success,
        pending: txn.pending,
        specialReference: txn.specialReference,
        amountCents: txn.amountCents,
      },
      "Parsed webhook transaction"
    );

    // 3. Find order by special_reference (our orderId)
    const orderId = txn.specialReference;
    if (!orderId) {
      logger.error({ txn }, "No special_reference in webhook");
      return res.status(400).json({ error: "Missing order reference" });
    }

    const order = await getOrderById(orderId);
    if (!order) {
      logger.error({ orderId }, "Order not found for webhook");
      return res.status(404).json({ error: "Order not found" });
    }

    // 4. Skip if order already processed (idempotency)
    if (order.status === "paid") {
      logger.info({ orderId }, "Order already paid, skipping duplicate webhook");
      return res.json({ received: true, status: "already_processed" });
    }

    // 5. Update order status based on transaction result
    if (txn.success && !txn.pending) {
      // Payment successful - mark paid and grant credits
      const result = await markOrderPaid(orderId, txn.transactionId);

      logger.info(
        {
          orderId,
          transactionId: txn.transactionId,
          alreadyGranted: result.alreadyGranted,
          userPackageId: result.userPackage?.id,
        },
        "Order marked as paid, credits granted"
      );
    } else if (txn.errorOccurred || (!txn.success && !txn.pending)) {
      // Payment failed
      await markOrderFailed(orderId, "Payment failed or declined");
      logger.info({ orderId }, "Order marked as failed");
    } else if (txn.pending) {
      // Still pending - do nothing, wait for final webhook
      logger.info({ orderId }, "Payment still pending");
    }

    // Always return 200 to acknowledge webhook
    return res.json({ received: true });
  } catch (err) {
    logger.error({ err }, "Webhook processing error");
    // Still return 200 to prevent Paymob retries on our errors
    return res.status(200).json({ received: true, error: "Processing error" });
  }
});

// Keep legacy callback for backwards compatibility (redirects to webhook logic)
router.post("/callback", async (req, res) => {
  logger.warn("Legacy /callback endpoint hit - redirecting to /webhook logic");
  // Forward to webhook handler
  req.url = "/webhook";
  return router.handle(req, res);
});

/**
 * GET /orders/:orderId
 * Returns order status for frontend polling
 */
router.get("/orders/:orderId", requireAuth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.user.id;

    const order = await getOrderById(orderId);

    // Check order exists and belongs to user
    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    if (order.userId !== userId) {
      logger.warn(
        { orderId, orderUserId: order.userId, requestUserId: userId },
        "User tried to access another user's order"
      );
      return res.status(403).json({ error: "Access denied" });
    }

    return res.json({
      id: order.id,
      status: order.status,
      amountCents: order.amountCents,
      currency: order.currency,
      createdAt: order.createdAt,
      userPackage: order.userPackage
        ? {
          id: order.userPackage.id,
          title: order.userPackage.title,
          sessionsTotal: order.userPackage.sessionsTotal,
          sessionsUsed: order.userPackage.sessionsUsed,
          status: order.userPackage.status,
        }
        : null,
    });
  } catch (err) {
    logger.error({ err, orderId: req.params.orderId }, "Get order error");
    return res.status(500).json({ error: "Failed to get order" });
  }
});

export default router;
