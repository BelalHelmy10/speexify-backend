import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPaymobEventKey,
  hashWebhookSignature,
} from "../../src/services/paymentReconciliationService.js";

test("hashWebhookSignature returns a deterministic non-raw fingerprint", () => {
  const signature = "  paymob-signature-value  ";
  const first = hashWebhookSignature(signature);
  const second = hashWebhookSignature(signature.trim());

  assert.equal(first, second);
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.includes("paymob-signature-value"), false);
});

test("hashWebhookSignature treats missing signatures as null", () => {
  assert.equal(hashWebhookSignature(null), null);
  assert.equal(hashWebhookSignature(undefined), null);
  assert.equal(hashWebhookSignature(""), null);
  assert.equal(hashWebhookSignature("   "), null);
});

test("buildPaymobEventKey remains stable for equivalent transaction data", () => {
  const txn = {
    transactionId: "txn_123",
    specialReference: "order_456",
    success: true,
    pending: false,
    errorOccurred: false,
    isRefunded: false,
    isVoided: false,
    amountCents: 150000,
    currency: "EGP",
  };

  assert.equal(buildPaymobEventKey(txn), buildPaymobEventKey({ ...txn }));
});
