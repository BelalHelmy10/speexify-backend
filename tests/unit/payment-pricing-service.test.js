import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPaymentQuote,
  getTrustedCountryFromHeaders,
  normalizeDiscountCode,
  validateDiscount,
} from "../../src/services/paymentPricingService.js";

test("buildPaymentQuote computes EGP amount from server package and discount data", async () => {
  const quote = await buildPaymentQuote({
    pkg: {
      id: 7,
      active: true,
      priceType: "BUNDLE",
      priceUSD: 1000,
    },
    discount: {
      id: 3,
      code: "SAVE20",
      active: true,
      percentage: 20,
      expiresAt: null,
      maxUses: null,
      usedCount: 0,
    },
    countryCode: "EG",
  });

  assert.equal(quote.packageId, 7);
  assert.equal(quote.discountCodeId, 3);
  assert.equal(quote.discountPercentage, 20);
  assert.equal(quote.displayCurrency, "EGP");
  assert.equal(quote.displayAmountCents, 80000);
  assert.equal(quote.egpAmountCents, 80000);
});

test("buildPaymentQuote rejects packages that cannot be bought online", async () => {
  await assert.rejects(
    () =>
      buildPaymentQuote({
        pkg: {
          id: 8,
          active: true,
          priceType: "CUSTOM",
          priceUSD: 1000,
        },
        discount: null,
        countryCode: "EG",
      }),
    {
      code: "CUSTOM_PACKAGE",
      status: 400,
    }
  );
});

test("discount helpers normalize codes and reject exhausted discounts", () => {
  assert.equal(normalizeDiscountCode(" save20 "), "SAVE20");
  assert.equal(
    validateDiscount({
      id: 1,
      code: "USED",
      active: true,
      percentage: 10,
      expiresAt: null,
      maxUses: 5,
      usedCount: 5,
    }),
    null
  );
});

test("trusted payment country ignores generic client-controlled country headers", () => {
  assert.equal(
    getTrustedCountryFromHeaders({
      headers: {
        "x-country-code": "EG",
      },
    }),
    null
  );

  assert.equal(
    getTrustedCountryFromHeaders({
      headers: {
        "cf-ipcountry": "US",
      },
    }),
    "US"
  );
});
