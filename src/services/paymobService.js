// src/services/paymobService.js
import axios from "axios";
import { PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY } from "../config/env.js";
import { logger } from "../lib/logger.js";

const PAYMOB_API_URL = "https://accept.paymob.com/v1";

/**
 * Create a Payment Intention (Unified Checkout)
 * @param {Object} params
 * @param {number} params.amountCents - Amount in cents (e.g. 1000 for 10 EGP)
 * @param {string} params.currency - e.g. "EGP"
 * @param {string} params.orderId - Unique order ID from our system
 * @param {Object} params.billingData - { firstName, lastName, email, phone }
 * @param {Array} params.paymentMethods - (Optional) List of method IDs, or empty for all
 * @returns {Promise<{ clientSecret: string, checkoutUrl: string }>}
 */
export async function createPaymentIntention({
  amountCents,
  currency = "EGP",
  orderId,
  billingData,
  paymentMethods = [],
}) {
  try {
    // 1. Prepare the payload
    const payload = {
      amount: amountCents, // Intention API takes cents directly for EGP
      currency,
      payment_methods: paymentMethods.length > 0 ? paymentMethods : undefined, // undefined lets Paymob show all enabled methods
      billing_data: {
        first_name: billingData.firstName || "NA",
        last_name: billingData.lastName || "NA",
        email: billingData.email || "NA",
        phone_number: billingData.phone || "NA",

        // Mandatory fields for some methods, can use defaults if not collected
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
      special_reference: orderId, // Link our Order ID to this transaction

      // Where to redirect after payment (Success or Fail)
      // We will handle the status check on the return URL
      // Make sure this matches your Frontend URL
      // If deployed, use your production URL. For now, we'll try to pick it up dynamically or hardcode it.
      // Ideally, pass this from the controller or config.
    };

    // 2. Make Request
    const response = await axios.post(`${PAYMOB_API_URL}/intention/`, payload, {
      headers: {
        Authorization: `Token ${PAYMOB_SECRET_KEY}`, // Secret Key
        "Content-Type": "application/json",
      },
    });

    const data = response.data;

    // 3. Extract the Checkout URL
    // The Intention API returns a 'next_action' with the redirection URL (Unified Checkout)
    // Sometimes it might return keys differently depending on version, but typically:
    // next_action: { url: "..." }

    const checkoutUrl =
      data.next_action?.url ||
      `https://accept.paymob.com/unifiedcheckout/?publicKey=${PAYMOB_PUBLIC_KEY}&clientSecret=${data.client_secret}`;

    logger.info({ orderId, intentionId: data.id }, "Paymob Intention Created");

    return {
      intentionId: data.id,
      clientSecret: data.client_secret,
      checkoutUrl: checkoutUrl,
    };
  } catch (error) {
    logger.error(
      {
        err: error.response?.data || error.message,
        orderId,
      },
      "Failed to create Paymob Intention",
    );
    throw new Error("Payment initialization failed");
  }
}
