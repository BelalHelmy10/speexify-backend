// src/services/paymobService.js
import axios from "axios";
import { PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY } from "../config/env.js";
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
    if (!PAYMOB_API_KEY) throw new Error("PAYMOB_API_KEY is missing");
    if (!PAYMOB_PUBLIC_KEY) throw new Error("PAYMOB_PUBLIC_KEY is missing");

    // 1) Prepare payload
    const payload = {
      amount: amountCents,
      currency,
      payment_methods: paymentMethods.length > 0 ? paymentMethods : undefined,
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

    // ✅ TEMP sanity log (safe preview) — remove later
    logger.info(
      {
        hasApiKey: !!PAYMOB_API_KEY,
        apiKeyLen: PAYMOB_API_KEY.length,
        apiKeyPreview: `${PAYMOB_API_KEY.slice(0, 12)}...${PAYMOB_API_KEY.slice(
          -6,
        )}`,
      },
      "Paymob API key loaded",
    );

    // 2) Request Paymob Intention
    const response = await axios.post(`${PAYMOB_API_URL}/intention/`, payload, {
      headers: {
        // ✅ try API key for authorization
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
        PAYMOB_PUBLIC_KEY,
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
      "Failed to create Paymob Intention",
    );

    const e = new Error("Payment initialization failed");
    e.status = status;
    e.paymob = paymob;
    throw e;
  }
}
