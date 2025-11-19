// src/routes/payments.js
/* ========================================================================== */
/*                             PAYMENTS: PAYMOB                               */
/*   Step 1: hosted checkout (iframe) flow                                    */
/*   Routes:                                                                   */
/*     POST /api/payments/create-intent  -> returns iframeUrl                  */
/*     POST /api/payments/webhook/paymob -> Paymob webhook (verify HMAC)       */
/* ========================================================================== */
import { Router } from "express";
import axios from "axios";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  PAYMOB_API_KEY,
  PAYMOB_IFRAME_ID,
  PAYMOB_HMAC_SECRET,
  PAYMOB_INTEGRATION_ID,
} from "../config/env.js";

const router = Router();
const prisma = new PrismaClient();

// Base URL for Paymob APIs
const PAYMOB_BASE = "https://accept.paymob.com/api";

if (
  !PAYMOB_API_KEY ||
  !PAYMOB_INTEGRATION_ID ||
  !PAYMOB_IFRAME_ID ||
  !PAYMOB_HMAC_SECRET
) {
  logger.warn(
    {},
    "⚠️  Missing one or more Paymob env vars (PAYMOB_API_KEY, PAYMOB_INTEGRATION_ID, PAYMOB_IFRAME_ID, PAYMOB_HMAC_SECRET). Test mode will fail until set."
  );
}

// -- helper: get Paymob auth token
async function paymobAuthToken() {
  const { data } = await axios.post(`${PAYMOB_BASE}/auth/tokens`, {
    api_key: PAYMOB_API_KEY,
  });
  return data.token;
}

// -- helper: build iframe URL
function paymobIframeUrl(paymentToken) {
  return `${PAYMOB_BASE}/acceptance/iframes/${PAYMOB_IFRAME_ID}?payment_token=${paymentToken}`;
}

// -- helper: verify HMAC from Paymob webhook
function verifyPaymobHmac(payloadObj, hmacFromPaymob) {
  const FIELDS = [
    "amount_cents",
    "created_at",
    "currency",
    "error_occured",
    "has_parent_transaction",
    "id",
    "integration_id",
    "is_3d_secure",
    "is_auth",
    "is_capture",
    "is_refunded",
    "is_standalone_payment",
    "is_voided",
    "order.id",
    "owner",
    "pending",
    "source_data.pan",
    "source_data.sub_type",
    "source_data.type",
    "success",
  ];
  const get = (obj, path) =>
    path
      .split(".")
      .reduce((o, k) => (o && o[k] !== undefined ? o[k] : ""), obj);
  const concatenated = FIELDS.map((f) => String(get(payloadObj, f))).join("");
  const computed = crypto
    .createHmac("sha512", PAYMOB_HMAC_SECRET)
    .update(concatenated)
    .digest("hex");
  return computed === hmacFromPaymob;
}

/**
 * POST /api/payments/create-intent
 */
router.post("/create-intent", async (req, res) => {
  try {
    const { amountCents, orderId, customer, currency = "EGP" } = req.body || {};

    const buyerId = req.session?.user?.id || null;

    const packageId =
      typeof req.body?.packageId === "number"
        ? req.body.packageId
        : (() => {
            const m = String(orderId).match(/_(\d+)_user/i);
            return m ? Number(m[1]) : null;
          })();

    if (!amountCents || !orderId) {
      return res
        .status(400)
        .json({ ok: false, message: "amountCents & orderId are required" });
    }

    const token = await paymobAuthToken();

    const { data: order } = await axios.post(
      `${PAYMOB_BASE}/ecommerce/orders`,
      {
        auth_token: token,
        delivery_needed: false,
        amount_cents: Number(amountCents),
        currency,
        merchant_order_id: String(orderId),
        items: [],
      }
    );

    const { data: paymentKey } = await axios.post(
      `${PAYMOB_BASE}/acceptance/payment_keys`,
      {
        auth_token: token,
        amount_cents: Number(amountCents),
        currency,
        order_id: order.id,
        billing_data: {
          first_name: customer?.firstName || "NA",
          last_name: customer?.lastName || "NA",
          email: customer?.email || "na@example.com",
          phone_number: customer?.phone || "01000000000",
          apartment: "NA",
          floor: "NA",
          street: "NA",
          building: "NA",
          shipping_method: "NA",
          postal_code: "NA",
          city: "Cairo",
          country: "EG",
          state: "EG",
        },
        expiration: 3600,
        integration_id: Number(PAYMOB_INTEGRATION_ID),
      }
    );

    const iframeUrl = paymobIframeUrl(paymentKey.token);

    await prisma.order.create({
      data: {
        id: String(orderId),
        amountCents: Number(amountCents),
        currency,
        status: "pending",
        psp: "paymob",
        pspOrderId: order.id,
        userId: buyerId,
        packageId: packageId,
        customerEmail: customer?.email || null,
        customerPhone: customer?.phone || null,
      },
    });

    return res.json({ ok: true, iframeUrl, paymobOrderId: order.id });
  } catch (err) {
    logger.error({ err }, "create-intent error");
    return res.status(500).json({ ok: false, message: "payment init failed" });
  }
});

/**
 * POST /api/payments/webhook/paymob
 */
router.post("/webhook/paymob", async (req, res) => {
  try {
    const hmac = req.query?.hmac || req.body?.hmac;
    const payload = req.body?.obj || req.body;

    if (!hmac || !payload) return res.sendStatus(400);

    const valid = verifyPaymobHmac(payload, hmac);
    if (!valid) return res.sendStatus(400);

    const success = payload?.success === true;
    const merchantOrderId = payload?.order?.merchant_order_id;
    const paymobOrderId = payload?.order?.id;

    await prisma.order.update({
      where: { id: String(merchantOrderId) },
      data: {
        status: success ? "paid" : "failed",
        pspOrderId: paymobOrderId,
      },
    });

    if (success) {
      const ord = await prisma.order.findUnique({
        where: { id: String(merchantOrderId) },
        select: {
          id: true,
          userId: true,
          packageId: true,
        },
      });

      if (ord?.userId && ord?.packageId) {
        const pkg = await prisma.package.findUnique({
          where: { id: Number(ord.packageId) },
          select: {
            id: true,
            title: true,
            sessionsPerPack: true,
            durationMin: true,
          },
        });

        if (pkg) {
          const sessionsTotal = Number(pkg.sessionsPerPack || 0);
          if (sessionsTotal > 0) {
            const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);

            await prisma.userPackage.create({
              data: {
                userId: ord.userId,
                packageId: pkg.id,
                title: pkg.title,
                minutesPerSession: pkg.durationMin || null,
                sessionsTotal,
                sessionsUsed: 0,
                expiresAt,
                status: "active",
              },
            });
          }
        }
      }
    }

    return res.sendStatus(200);
  } catch (e) {
    logger.error({ err: e }, "webhook error");
    return res.sendStatus(500);
  }
});

export default router;
