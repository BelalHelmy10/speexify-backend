// src/routes/payments.js
import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { logger } from "../lib/logger.js";
import {
  createPaymentIntention,
  verifyWebhookHMAC,
  parseTransactionCallback,
} from "../services/paymobService.js";
import {
  beginPaymobWebhookReconciliation,
  buildPaymobEventKey,
  markWebhookEventProcessed,
  markWebhookEventIgnored,
  markWebhookEventFailed,
} from "../services/paymentReconciliationService.js";
import {
  createPendingOrder,
  markOrderPaid,
  markOrderFailed,
  markOrderPendingForRetry,
  getOrderById,
  orderExists,
} from "../services/orderService.js";
import {
  buildPaymentQuote,
  normalizeDiscountCode,
  resolvePaymentCountry,
  validateDiscount,
} from "../services/paymentPricingService.js";
import { prisma } from "../lib/prisma.js";

const router = Router();

const CreateIntentBodySchema = z
  .object({
    orderId: z.string().trim().min(1).max(120),
    customer: z
      .object({
        firstName: z.string().trim().max(120).optional(),
        lastName: z.string().trim().max(120).optional(),
        email: z.string().trim().email().optional(),
        phone: z.string().trim().max(40).optional(),
      })
      .default({}),
    packageId: z.coerce.number().int().positive(),
    countryCode: z.string().trim().length(2).optional().nullable(),
    discountCode: z.string().trim().max(64).optional().nullable(),
  })
  .strict();

const OrderIdParamsSchema = z.object({
  orderId: z.string().trim().min(1).max(120),
});

const RecoveryOrdersQuerySchema = z.object({
  packageId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10),
});

/**
 * POST /create-intent
 * Creates a pending Order record, then initiates Paymob payment intention
 */
router.post(
  "/create-intent",
  requireAuth,
  validateRequest({ body: CreateIntentBodySchema }),
  async (req, res) => {
    try {
      const { orderId, customer, packageId, countryCode, discountCode } = req.body;
      const userId = req.user.id;

      logger.info({ userId, orderId, packageId }, "Initiating payment intent");

      // Check if order already exists (idempotency)
      if (await orderExists(orderId)) {
        const existingOrder = await getOrderById(orderId);

        if (!existingOrder) {
          return res.status(404).json({
            ok: false,
            message: "Order not found",
          });
        }

        if (existingOrder.userId !== userId) {
          logger.warn(
            { orderId, orderUserId: existingOrder.userId, requestUserId: userId },
            "User tried to reuse another user's payment order"
          );
          return res.status(403).json({
            ok: false,
            message: "Access denied",
          });
        }

        // If order is already paid, don't allow re-payment
        if (existingOrder.status === "paid") {
          return res.status(400).json({
            ok: false,
            message: "This order has already been paid",
          });
        }

        const retryIntention = await createPaymentIntention({
          amountCents: Number(existingOrder.amountCents),
          currency: String(existingOrder.currency || "EGP").toUpperCase(),
          orderId,
          billingData: customer,
        });

        logger.warn(
          {
            orderId,
            userId,
            amountCents: existingOrder.amountCents,
            currency: existingOrder.currency,
            intentionId: retryIntention.intentionId,
          },
          "Order already exists, returning a new checkout intention for stored amount"
        );

        return res.json({
          ok: true,
          orderId,
          iframeUrl: retryIntention.checkoutUrl,
          intentionId: retryIntention.intentionId,
        });
      }

      const pkg = await prisma.package.findUnique({
        where: { id: Number(packageId) },
      });

      const normalizedDiscountCode = normalizeDiscountCode(discountCode);
      const discount = normalizedDiscountCode
        ? await prisma.discountCode.findUnique({
            where: { code: normalizedDiscountCode },
          })
        : null;
      const validDiscount = validateDiscount(discount);

      if (normalizedDiscountCode && !validDiscount) {
        return res.status(400).json({
          ok: false,
          code: "INVALID_DISCOUNT",
          message: "Discount code is invalid or no longer available",
        });
      }

      const resolvedCountry = await resolvePaymentCountry(req, countryCode);
      const quote = await buildPaymentQuote({
        pkg,
        discount: validDiscount,
        countryCode: resolvedCountry.countryCode,
      });

      logger.info(
        {
          orderId,
          packageId,
          countryCode: quote.countryCode,
          countrySource: resolvedCountry.source,
          displayCurrency: quote.displayCurrency,
          displayAmountCents: quote.displayAmountCents,
          egpAmountCents: quote.egpAmountCents,
          discountCodeId: quote.discountCodeId,
        },
        "Server-computed payment quote"
      );

      // Create pending order in database BEFORE calling Paymob
      await createPendingOrder({
        orderId,
        userId,
        packageId,
        amountCents: quote.egpAmountCents,
        currency: quote.egpCurrency,
        displayAmountCents: quote.displayAmountCents,
        displayCurrency: quote.displayCurrency,
        customerEmail: customer.email,
        customerPhone: customer.phone,
        discountCodeId: quote.discountCodeId,
      });

      // Create Paymob payment intention (ALWAYS in EGP)
      const intention = await createPaymentIntention({
        amountCents: quote.egpAmountCents,
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
        "Paymob Intention Created"
      );

      return res.json({
        ok: true,
        orderId,
        iframeUrl: intention.checkoutUrl,
        intentionId: intention.intentionId,
        pricing: {
          packageId: quote.packageId,
          countryCode: quote.countryCode,
          countrySource: resolvedCountry.source,
          displayAmountCents: quote.displayAmountCents,
          displayCurrency: quote.displayCurrency,
          amountCents: quote.egpAmountCents,
          currency: quote.egpCurrency,
          discountPercentage: quote.discountPercentage,
        },
      });
    } catch (err) {
      logger.error({ err }, "Create Intent Error");

      if (err?.status && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({
          ok: false,
          code: err.code,
          message: err.message || "Invalid payment request",
        });
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
  }
);

/**
 * GET /orders/recovery
 * Returns recent unpaid orders to help users recover from flaky connectivity/payment redirects.
 */
router.get(
  "/orders/recovery",
  requireAuth,
  validateRequest({ query: RecoveryOrdersQuerySchema }),
  async (req, res) => {
    try {
      const userId = req.user.id;
      const { packageId, limit } = req.query;

      const where = {
        userId,
        status: { in: ["pending", "failed"] },
        ...(packageId ? { packageId: Number(packageId) } : {}),
      };

      const items = await prisma.order.findMany({
        where,
        orderBy: [{ updatedAt: "desc" }],
        take: Number(limit),
        select: {
          id: true,
          status: true,
          amountCents: true,
          currency: true,
          packageId: true,
          createdAt: true,
          updatedAt: true,
          package: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      });

      return res.json({ items });
    } catch (err) {
      logger.error({ err, userId: req.user?.id }, "List recovery orders error");
      return res.status(500).json({ error: "Failed to list recovery orders" });
    }
  }
);

/**
 * POST /webhook
 * Paymob callback/webhook handler
 * Verifies HMAC, updates order status, grants credits on success
 */
router.post("/webhook", async (req, res) => {
  let reconciliation = null;
  let txn = null;
  let orderId = null;

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
    txn = parseTransactionCallback(body);
    orderId = txn.specialReference || txn.merchantOrderId || null;
    const transactionId =
      txn.transactionId == null ? null : String(txn.transactionId);

    // 3. Record webhook receipt and dedupe processing
    const eventKey = buildPaymobEventKey({
      ...txn,
      specialReference: orderId || txn.specialReference || null,
    });

    reconciliation = await beginPaymobWebhookReconciliation({
      eventKey,
      orderId,
      transactionId,
      payload: body,
      signature: typeof hmac === "string" ? hmac : null,
    });

    if (reconciliation.state === "replay") {
      logger.info(
        { eventKey, orderId, transactionId },
        "Duplicate webhook replay detected; skipping"
      );
      return res.json({ received: true, status: "duplicate" });
    }

    if (reconciliation.state === "in_progress") {
      logger.info(
        { eventKey, orderId, transactionId },
        "Webhook is already being processed"
      );
      return res.status(202).json({ received: true, status: "in_progress" });
    }

    if (reconciliation.state === "conflict") {
      logger.warn(
        { eventKey, orderId, transactionId },
        "Webhook event key conflict with different payload"
      );
      return res.status(200).json({ received: true, status: "conflict_ignored" });
    }

    if (reconciliation.state === "error") {
      logger.error(
        { eventKey, orderId, transactionId },
        "Failed to initialize webhook reconciliation record"
      );
      return res.status(500).json({ error: "Webhook reconciliation unavailable" });
    }

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

    // 4. Find order by special_reference (our orderId)
    if (!orderId) {
      logger.error({ txn }, "No order reference in webhook");
      await markWebhookEventIgnored(reconciliation?.recordId, {
        transactionId,
        reason: "missing_order_reference",
      });
      return res.status(400).json({ error: "Missing order reference" });
    }

    const order = await getOrderById(orderId);
    if (!order) {
      logger.error({ orderId, transactionId }, "Order not found for webhook");
      await markWebhookEventFailed(reconciliation?.recordId, {
        orderId,
        transactionId,
        error: "order_not_found",
      });
      return res.status(503).json({ error: "Order not found yet; retry later" });
    }

    const amountMatches =
      txn.amountCents == null ||
      Number(txn.amountCents) === Number(order.amountCents);
    const currencyMatches =
      !txn.currency ||
      String(txn.currency).toUpperCase() ===
        String(order.currency || "").toUpperCase();

    if (!amountMatches || !currencyMatches) {
      const reconciliationError = `amount_or_currency_mismatch order=${order.id} txnAmount=${txn.amountCents} orderAmount=${order.amountCents} txnCurrency=${txn.currency} orderCurrency=${order.currency}`;
      logger.error({ orderId, txn }, "Webhook reconciliation mismatch");
      await markWebhookEventFailed(reconciliation?.recordId, {
        orderId,
        transactionId,
        error: reconciliationError,
      });
      return res.status(409).json({ error: "Payment reconciliation mismatch" });
    }

    // 5. Skip if order already processed (idempotency)
    if (order.status === "paid") {
      logger.info({ orderId }, "Order already paid, skipping duplicate webhook");
      await markWebhookEventProcessed(reconciliation?.recordId, {
        orderId,
        transactionId,
        resolution: "already_paid",
      });
      return res.json({ received: true, status: "already_processed" });
    }

    // 6. Update order status based on transaction result
    let resolution = "pending";

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
      resolution = result.alreadyGranted ? "paid_already_granted" : "paid_granted";
    } else if (txn.errorOccurred || (!txn.success && !txn.pending)) {
      // Payment failed
      const failResult = await markOrderFailed(orderId, "payment_failed_or_declined");
      logger.info({ orderId }, "Order marked as failed");
      resolution = failResult?.skipped ? "failed_ignored_paid_order" : "failed_marked";
    } else if (txn.pending) {
      // Still pending - do nothing, wait for final webhook
      logger.info({ orderId }, "Payment still pending");
      resolution = "pending";
    }

    await markWebhookEventProcessed(reconciliation?.recordId, {
      orderId,
      transactionId,
      resolution,
    });

    // Return 200 for handled states
    return res.json({ received: true });
  } catch (err) {
    logger.error({ err, orderId, txn }, "Webhook processing error");

    await markWebhookEventFailed(reconciliation?.recordId, {
      orderId,
      transactionId:
        txn?.transactionId == null ? null : String(txn.transactionId),
      error: err?.message || "webhook_processing_error",
    });

    // Return non-2xx so provider retries recoverable failures.
    return res.status(500).json({ received: false, error: "Processing error" });
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

/**
 * POST /orders/:orderId/retry-intent
 * Re-opens checkout for an existing unpaid order (network drop / callback failure recovery).
 */
router.post(
  "/orders/:orderId/retry-intent",
  requireAuth,
  validateRequest({ params: OrderIdParamsSchema }),
  async (req, res) => {
    try {
      const { orderId } = req.params;
      const userId = req.user.id;

      const order = await getOrderById(orderId);

      if (!order) {
        return res.status(404).json({ ok: false, error: "Order not found" });
      }

      if (order.userId !== userId) {
        logger.warn(
          { orderId, orderUserId: order.userId, requestUserId: userId },
          "User tried to retry another user's order"
        );
        return res.status(403).json({ ok: false, error: "Access denied" });
      }

      if (order.status === "paid") {
        return res
          .status(409)
          .json({ ok: false, error: "Order already paid", status: "paid" });
      }

      await markOrderPendingForRetry(orderId, "retry_intent_requested");

      const [firstName = "User", ...rest] = String(req.user?.name || "User")
        .trim()
        .split(/\s+/);
      const lastName = rest.join(" ");

      const intention = await createPaymentIntention({
        amountCents: Number(order.amountCents),
        currency: String(order.currency || "EGP").toUpperCase(),
        orderId,
        billingData: {
          firstName,
          lastName,
          email: order.customerEmail || req.user?.email || "user@example.com",
          phone: order.customerPhone || "01000000000",
        },
      });

      logger.info(
        { orderId, userId, intentionId: intention.intentionId },
        "Payment retry intention created"
      );

      return res.json({
        ok: true,
        orderId,
        iframeUrl: intention.checkoutUrl,
        intentionId: intention.intentionId,
      });
    } catch (err) {
      logger.error(
        { err, orderId: req.params?.orderId, userId: req.user?.id },
        "Retry payment intent error"
      );
      return res
        .status(500)
        .json({ ok: false, error: "Payment retry failed" });
    }
  }
);

export default router;
