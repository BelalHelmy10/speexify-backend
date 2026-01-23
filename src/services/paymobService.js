// src/services/paymobService.js
import axios from "axios";
import crypto from "node:crypto";
import {
  PAYMOB_SECRET_KEY,
  PAYMOB_PUBLIC_KEY,
  PAYMOB_API_KEY,
  PAYMOB_INTEGRATION_ID,
  PAYMOB_HMAC_SECRET,
} from "../config/env.js";
import { logger } from "../lib/logger.js";

const PAYMOB_API_URL = "https://accept.paymob.com/v1";

/**
 * Create a Payment Intention (Unified Checkout)
 */
export async function createPaymentIntention({
  amountCents,
  currency = "EGP",
  orderId,
  billingData,
  paymentMethods = [],
}) {
  try {
    // Basic env validation
    if (!PAYMOB_SECRET_KEY) throw new Error("PAYMOB_SECRET_KEY is missing");
    if (!PAYMOB_PUBLIC_KEY) throw new Error("PAYMOB_PUBLIC_KEY is missing");

    // 1) Prepare payload
    const payload = {
      amount: amountCents,
      currency,
      payment_methods:
        paymentMethods.length > 0
          ? paymentMethods
          : [parseInt(PAYMOB_INTEGRATION_ID, 10)],
      billing_data: {
        first_name: billingData?.firstName || "NA",
        last_name: billingData?.lastName || "NA",
        email: billingData?.email || "NA",
        phone_number: billingData?.phone || "NA",

        apartment: "NA",
        floor: "NA",
        street: "NA",
        building: "NA",
        shipping_method: "NA",
        postal_code: "NA",
        city: "NA",
        country: "EG",
        state: "NA",
      },
      special_reference: orderId,
    };

    // 2) Request Paymob Intention
    const response = await axios.post(`${PAYMOB_API_URL}/intention`, payload, {
      headers: {
        Authorization: `Token ${PAYMOB_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 20000,
    });

    const data = response.data;

    // 3) Checkout URL
    const checkoutUrl =
      data?.next_action?.url ||
      `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(
        PAYMOB_PUBLIC_KEY
      )}&clientSecret=${encodeURIComponent(data.client_secret)}`;

    logger.info({ orderId, intentionId: data?.id }, "Paymob Intention Created");

    return {
      intentionId: data.id,
      clientSecret: data.client_secret,
      checkoutUrl,
    };
  } catch (error) {
    const status = error?.response?.status;
    const paymob = error?.response?.data;

    logger.error(
      { status, paymob, msg: error?.message, orderId },
      "Failed to create Paymob Intention"
    );

    const e = new Error("Payment initialization failed");
    e.status = status;
    e.paymob = paymob;
    throw e;
  }
}

/**
 * Verify HMAC signature from Paymob webhook callback
 * Paymob sends an HMAC in the query string that must be verified
 *
 * @param {object} body - The request body (obj field from Paymob)
 * @param {string} hmac - The HMAC from query params
 * @returns {boolean} - Whether the HMAC is valid
 */
export function verifyWebhookHMAC(body, hmac) {
  if (!PAYMOB_HMAC_SECRET) {
    logger.error("PAYMOB_HMAC_SECRET is not configured");
    return false;
  }

  if (!hmac) {
    logger.warn("No HMAC provided in webhook");
    return false;
  }

  // Paymob's HMAC is calculated by concatenating specific fields in order
  // Fields must be sorted alphabetically and their values concatenated
  const obj = body?.obj || body;

  // The fields that Paymob includes in HMAC calculation (sorted alphabetically)
  const hmacFields = [
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

  // Build the concatenated string
  const concatenated = hmacFields
    .map((field) => {
      // Handle nested fields like "order.id" and "source_data.pan"
      const value = field.split(".").reduce((o, k) => o?.[k], obj);
      return value?.toString() ?? "";
    })
    .join("");

  // Calculate HMAC-SHA512
  const calculated = crypto
    .createHmac("sha512", PAYMOB_HMAC_SECRET)
    .update(concatenated)
    .digest("hex");

  const isValid = calculated === hmac;

  if (!isValid) {
    logger.warn(
      { expectedLength: calculated.length, receivedLength: hmac?.length },
      "HMAC verification failed"
    );
  }

  return isValid;
}

/**
 * Parse transaction data from Paymob callback
 * Extracts the relevant fields we need
 *
 * @param {object} body - The webhook body
 * @returns {object} - Parsed transaction data
 */
export function parseTransactionCallback(body) {
  const obj = body?.obj || body;

  return {
    transactionId: obj?.id,
    success: obj?.success === true,
    pending: obj?.pending === true,
    amountCents: obj?.amount_cents,
    currency: obj?.currency,
    orderId: obj?.order?.id,
    merchantOrderId: obj?.order?.merchant_order_id || obj?.payment_key_claims?.billing_data?.extra_description,
    specialReference: obj?.special_reference,
    errorOccurred: obj?.error_occured === true,
    isRefunded: obj?.is_refunded === true,
    isVoided: obj?.is_voided === true,
    sourceType: obj?.source_data?.type,
    sourceSubType: obj?.source_data?.sub_type,
    maskedPan: obj?.source_data?.pan,
    createdAt: obj?.created_at,
  };
}
