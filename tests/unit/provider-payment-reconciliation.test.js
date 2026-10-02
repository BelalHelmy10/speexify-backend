import test from "node:test";
import assert from "node:assert/strict";
import {
  expectedPaymobLiveMode,
  reconcileOrderFromPaymob,
  reconcilePendingPaymentsBatch,
  verifyPaymobPaymentForOrder,
} from "../../src/services/providerPaymentReconciliation.js";

const order = {
  id: "order_123",
  status: "pending",
  userId: 7,
  packageId: 3,
  amountCents: 80000,
  currency: "EGP",
  userPackage: null,
};

const paidTransaction = {
  id: 12345,
  order: { merchant_order_id: order.id, paid_amount_cents: 80000 },
  amount_cents: 80000,
  currency: "EGP",
  is_live: true,
  pending: false,
  success: true,
  error_occured: false,
  is_auth: false,
  is_refunded: false,
  is_voided: false,
  refunded_amount_cents: 0,
};

test("recognizes Paymob live and test keys", () => {
  assert.equal(expectedPaymobLiveMode("egy_sk_live_example"), true);
  assert.equal(expectedPaymobLiveMode("egy_sk_test_example"), false);
  assert.throws(() => expectedPaymobLiveMode("unknown"));
});

test("only a matching, fully paid, unrefunded provider transaction grants credits", () => {
  assert.deepEqual(verifyPaymobPaymentForOrder(order, paidTransaction, true),
    { confirmed: true, transactionId: 12345 });

  const cases = [
    [{ order: { ...paidTransaction.order, merchant_order_id: "another_order" } }, "reference_mismatch"],
    [{ amount_cents: 79999 }, "amount_or_currency_mismatch"],
    [{ is_live: false }, "payment_mode_mismatch"],
    [{ pending: true }, "payment_pending"],
    [{ success: false }, "payment_failed"],
    [{ is_auth: true }, "payment_not_completed"],
    [{ is_refunded: true }, "payment_refunded_or_voided"],
    [{ refunded_amount_cents: 100 }, "payment_refunded_or_voided"],
    [{ order: { ...paidTransaction.order, paid_amount_cents: 40000 } }, "partial_payment"],
  ];
  for (const [change, reason] of cases) {
    const result = verifyPaymobPaymentForOrder(order, { ...paidTransaction, ...change }, true);
    assert.equal(result.confirmed, false);
    assert.equal(result.reason, reason);
  }
});

test("provider reconciliation grants credits once and never grants for an unverified payment", async () => {
  const db = { order: { findUnique: async () => order } };
  const grants = [];
  const markPaid = async (id, transactionId) => {
    grants.push({ id, transactionId });
    return { userPackage: { id: 42 } };
  };

  const paid = await reconcileOrderFromPaymob(order.id, {
    db, inquire: async () => paidTransaction, markPaid, expectedLive: true,
  });
  assert.equal(paid.status, "paid");
  assert.equal(paid.userPackageId, 42);
  assert.deepEqual(grants, [{ id: order.id, transactionId: 12345 }]);

  const rejected = await reconcileOrderFromPaymob(order.id, {
    db, inquire: async () => ({ ...paidTransaction, is_refunded: true }),
    markPaid, expectedLive: true,
  });
  assert.equal(rejected.status, "payment_refunded_or_voided");
  assert.equal(grants.length, 1);
});

test("pending-order sweep continues after an inquiry error", async () => {
  const now = new Date("2026-10-02T02:00:00Z");
  const orders = [
    { id: "one", updatedAt: new Date("2026-10-02T01:00:00Z") },
    { id: "two", updatedAt: new Date("2026-10-02T01:01:00Z") },
  ];
  const db = { order: { findMany: async () => orders } };
  const result = await reconcilePendingPaymentsBatch({
    db, now, reconcile: async id => {
      if (id === "one") throw new Error("provider unavailable");
      return { status: "paid" };
    },
  });
  assert.equal(result.inspected, 2);
  assert.equal(result.fulfilled, 1);
  assert.equal(result.errors, 1);
  assert.equal(result.cursor.id, "two");
});
