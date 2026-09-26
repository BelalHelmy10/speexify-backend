import test from "node:test";
import assert from "node:assert/strict";
import { resolvePaymobPaymentMethods } from "../../src/services/paymobService.js";

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
