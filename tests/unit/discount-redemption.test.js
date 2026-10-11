import test from "node:test";
import assert from "node:assert/strict";
import { consumeDiscountAfterSuccessfulPurchase } from "../../src/services/orderService.js";

test("a successful purchase consumes and closes a single-use discount", async () => {
  let updateArgs = null;
  const tx = {
    discountCode: {
      findUnique: async () => ({
        id: 14,
        code: "SPEEX25",
        active: true,
        maxUses: 1,
        usedCount: 0,
      }),
      updateMany: async (args) => {
        updateArgs = args;
        return { count: 1 };
      },
    },
  };

  const result = await consumeDiscountAfterSuccessfulPurchase(tx, 14);

  assert.deepEqual(result, {
    consumed: true,
    discountCode: "SPEEX25",
    usedCount: 1,
    maxUses: 1,
  });
  assert.deepEqual(updateArgs, {
    where: { id: 14, usedCount: 0 },
    data: { usedCount: { increment: 1 }, active: false },
  });
});

test("an exhausted discount is never consumed twice", async () => {
  let updates = 0;
  const tx = {
    discountCode: {
      findUnique: async () => ({
        id: 14,
        code: "SPEEX25",
        active: false,
        maxUses: 1,
        usedCount: 1,
      }),
      updateMany: async () => {
        updates += 1;
        return { count: 1 };
      },
    },
  };

  const result = await consumeDiscountAfterSuccessfulPurchase(tx, 14);

  assert.equal(result.consumed, false);
  assert.equal(result.reason, "already_exhausted");
  assert.equal(updates, 0);
});

test("failed or abandoned checkouts do not consume a discount", async () => {
  const result = await consumeDiscountAfterSuccessfulPurchase({ discountCode: {} }, null);
  assert.deepEqual(result, { consumed: false, reason: "no_discount" });
});
