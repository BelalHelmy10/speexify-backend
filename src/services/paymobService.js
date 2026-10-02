// src/services/paymobService.js
import axios from "axios";
import crypto from "node:crypto";
import {
  PAYMOB_SECRET_KEY,
  PAYMOB_PUBLIC_KEY,
  PAYMOB_API_KEY,
  PAYMOB_INTEGRATION_ID,
  PAYMOB_PAYMENT_METHOD_IDS,
  PAYMOB_HMAC_SECRET,
} from "../config/env.js";
import { logger } from "../lib/logger.js";

const PAYMOB_API_URL = "https://accept.paymob.com/v1";
const PAYMOB_LEGACY_API_URL = "https://accept.paymob.com/api";
let inquiryToken = null;
let inquiryTokenExpiresAt = 0;

function inquiryError(error) {
  const status = error?.response?.status;
  return new Error(status ? `Paymob inquiry unavailable (HTTP ${status})` : "Paymob inquiry unavailable");
}

export function resolvePaymobNotificationUrl({
  configuredUrl = process.env.PAYMOB_NOTIFICATION_URL,
  renderExternalUrl = process.env.RENDER_EXTERNAL_URL,
} = {}) {
  const candidate = String(configuredUrl || (renderExternalUrl
    ? `${String(renderExternalUrl).replace(/\/$/, "")}/api/payments/webhook`
    : "")).trim();

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("PAYMOB_NOTIFICATION_URL or RENDER_EXTERNAL_URL must provide a public webhook URL");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Paymob notification URL must be a public HTTPS URL without credentials, query, or fragment");
  }

  return url.toString();
}

async function getPaymobInquiryToken() {
  if (!PAYMOB_API_KEY) throw new Error("PAYMOB_API_KEY is missing");
  if (inquiryToken && Date.now() < inquiryTokenExpiresAt) return inquiryToken;

  let response;
  try {
    response = await axios.post(
      `${PAYMOB_LEGACY_API_URL}/auth/tokens`,
      { api_key: PAYMOB_API_KEY },
      { timeout: 10000 }
    );
  } catch (error) {
    throw inquiryError(error);
  }
  if (!response.data?.token) throw new Error("Paymob did not return an inquiry token");
  inquiryToken = response.data.token;
  inquiryTokenExpiresAt = Date.now() + 5 * 60 * 1000;
  return inquiryToken;
}

/** Read Paymob's latest transaction for an order reference. A 404 means no transaction yet. */
export async function inquirePaymobTransaction(orderId) {
  const reference = String(orderId || "").trim();
  if (!reference) throw new Error("Order reference is required for Paymob inquiry");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = await getPaymobInquiryToken();
      const response = await axios.post(
        `${PAYMOB_LEGACY_API_URL}/ecommerce/orders/transaction_inquiry`,
        { auth_token: token, merchant_order_id: reference },
        { timeout: 10000 }
      );
      return response.data;
    } catch (error) {
      if (error?.response?.status === 404) return null;
      if (error?.response?.status === 401 && attempt === 0) {
        inquiryToken = null;
        inquiryTokenExpiresAt = 0;
        continue;
      }
      throw inquiryError(error);
    }
  }
  return null;
}

/** Verify a signed callback against Paymob's current transaction record. */
export async function inquirePaymobTransactionById(transactionId) {
  const id = Number(transactionId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Valid Paymob transaction ID required");

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const token = await getPaymobInquiryToken();
      const response = await axios.get(
        `${PAYMOB_LEGACY_API_URL}/acceptance/transactions/${id}`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
      );
      return response.data;
    } catch (error) {
      if (error?.response?.status === 404) return null;
      if (error?.response?.status === 401 && attempt === 0) {
        inquiryToken = null;
        inquiryTokenExpiresAt = 0;
        continue;
      }
      throw inquiryError(error);
    }
  }
  return null;
}

function toPositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve the integration IDs sent to Paymob Unified Checkout.
 *
 * Explicit method IDs are supported for callers that need a narrowly scoped
 * checkout. Otherwise, use the configured list so the hosted checkout can
 * offer cards and wallets together. The legacy single integration ID remains
 * the final fallback for existing deployments.
 */
export function resolvePaymobPaymentMethods({
  paymentMethods = [],
  configuredPaymentMethodIds = PAYMOB_PAYMENT_METHOD_IDS,
  fallbackIntegrationId = PAYMOB_INTEGRATION_ID,
} = {}) {
  const requested = Array.isArray(paymentMethods)
    ? paymentMethods.map(toPositiveInteger).filter(Boolean)
    : [];
  if (requested.length > 0) return [...new Set(requested)];

  const configured = Array.isArray(configuredPaymentMethodIds)
    ? configuredPaymentMethodIds.map(toPositiveInteger).filter(Boolean)
    : [];
  if (configured.length > 0) return [...new Set(configured)];

  const fallback = toPositiveInteger(fallbackIntegrationId);
  if (fallback) return [fallback];

  throw new Error(
    "No Paymob payment method integration IDs are configured"
  );
}

export function buildPaymobIntentionPayload({
  amountCents,
  currency = "EGP",
  orderId,
  billingData,
  paymentMethods = [],
  notificationUrl = resolvePaymobNotificationUrl(),
}) {
  return {
    amount: amountCents,
    currency,
    payment_methods: resolvePaymobPaymentMethods({ paymentMethods }),
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
    notification_url: notificationUrl,
  };
}

/** Create a Payment Intention (Unified Checkout). */
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
    const payload = buildPaymobIntentionPayload({
      amountCents, currency, orderId, billingData, paymentMethods,
    });

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
