import test from "node:test";
import assert from "node:assert/strict";
import { buildPaymobIntentionPayload, resolvePaymobNotificationUrl, resolvePaymobPaymentMethods } from "../../src/services/paymobService.js";

test("every Paymob intention includes its order reference and callback URL", () => {
  const payload = buildPaymobIntentionPayload({
    orderId: "order_123",
    amountCents: 80000,
    currency: "EGP",
    billingData: { email: "buyer@example.test" },
    paymentMethods: [123],
    notificationUrl: "https://api.example.test/api/payments/webhook",
  });
  assert.equal(payload.special_reference, "order_123");
  assert.equal(payload.notification_url, "https://api.example.test/api/payments/webhook");
  assert.equal(payload.amount, 80000);
  assert.deepEqual(payload.payment_methods, [123]);
});

test("uses this Render service's public webhook URL for Paymob intentions", () => {
  assert.equal(resolvePaymobNotificationUrl({
    configuredUrl: "",
    renderExternalUrl: "https://speexify-backend.onrender.com/",
  }), "https://speexify-backend.onrender.com/api/payments/webhook");
});

test("allows a configured webhook URL and rejects missing or unsafe URLs", () => {
  assert.equal(resolvePaymobNotificationUrl({
    configuredUrl: "https://api.example.com/api/payments/webhook",
    renderExternalUrl: "https://other.onrender.com",
  }), "https://api.example.com/api/payments/webhook");
  assert.throws(() => resolvePaymobNotificationUrl({ configuredUrl: "", renderExternalUrl: "" }));
  assert.throws(() => resolvePaymobNotificationUrl({ configuredUrl: "http://api.example.com/webhook" }));
});

test("uses configured card and wallet integration IDs together", () => {
  assert.deepEqual(
    resolvePaymobPaymentMethods({
      configuredPaymentMethodIds: [5378514, 5947239],
      fallbackIntegrationId: "ignored",
    }),
    [5378514, 5947239]
  );
});

test("deduplicates and ignores invalid configured integration IDs", () => {
  assert.deepEqual(
    resolvePaymobPaymentMethods({
      configuredPaymentMethodIds: ["5378514", "bad", 5378514, 0, -2],
    }),
    [5378514]
  );
});

test("preserves an explicit method selection over the configured list", () => {
  assert.deepEqual(
    resolvePaymobPaymentMethods({
      paymentMethods: [5947239],
      configuredPaymentMethodIds: [5378514, 5947239],
    }),
    [5947239]
  );
});

test("falls back to the legacy integration ID", () => {
  assert.deepEqual(
    resolvePaymobPaymentMethods({
      configuredPaymentMethodIds: [],
      fallbackIntegrationId: "5378514",
    }),
    [5378514]
  );
});
