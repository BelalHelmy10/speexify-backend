import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createPricingRouter } from "../../src/routes/pricing.js";
import { createPaymentsRouter } from "../../src/routes/payments.js";
import { clearRateCache } from "../../src/services/currencyService.js";
import { resolvePaymentCountry } from "../../src/services/paymentPricingService.js";
import { readPricingToken, signPricingToken } from "../../src/services/pricingQuoteService.js";

function setup(country = "EG") {
  const pkg = {id: 3, catalogKey: "1on1-24", title: "Intensive", active: true, deletedAt: null,
    priceUSD: 5040, priceType: "BUNDLE", sessionsPerPack: 24, durationMin: 60,
    pricingOverrides: null};
  const discount = {id: 9, code: "SAVE10", active: true, percentage: 10};
  const orders = new Map();
  const sent = [];
  const db = {package: {findMany: async () => [pkg], findUnique: async () => pkg},
    discountCode: {findUnique: async ({where}) => where.code === "SAVE10" ? discount : null}};
  const app = express(); app.use(express.json());
  app.use("/pricing", createPricingRouter({db, resolveCountry: async () => ({countryCode: country, source: "test"})}));
  app.use("/payments", createPaymentsRouter({prisma: db,
    requireAuth: (req, _res, next) => {req.user = {id: 1}; next();},
    orderExists: async id => orders.has(id), getOrderById: async id => orders.get(id),
    createPendingOrder: async data => {const order = {...data, id: data.orderId, status: "pending"}; orders.set(order.id, order); return order;},
    markOrderPendingForRetry: async () => {},
    createPaymentIntention: async data => {sent.push(data); return {checkoutUrl: "https://example.test/payment", intentionId: "test"};},
  }));
  return {app, pkg, discount, orders, sent};
}

test("catalog → signed quote → stored order → Paymob agree across regions with fixed EGP pricing", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ok: false});
  clearRateCache();
  try {
    for (const country of ["EG", "US", "GB", "AE", "SA", "FR"]) {
      const {app, orders, sent} = setup(country);
      const catalog = (await request(app).get("/pricing/catalog").expect(200)).body;
      const quote = (await request(app).post("/pricing/quote").send({packageId: 3, regionToken: catalog.regionToken}).expect(200)).body;
      assert.equal(catalog.packages[0].pricing.displayAmount, quote.pricing.displayAmount);
      assert.equal(quote.pricing.countryCode, country);
      assert.equal(quote.pricing.displayAmount, 5040);
      assert.equal(quote.pricing.displayCurrency, "EGP");
      assert.equal(quote.pricing.amountCents, 504000);
      const paid = (await request(app).post("/payments/create-intent").send({orderId: "fresh", packageId: 3, quoteToken: quote.quoteToken}).expect(200)).body;
      assert.equal(paid.pricing.amountCents, quote.pricing.amountCents);
      assert.equal(paid.chargeAmountEGP * 100, sent[0].amountCents);
      assert.equal(orders.get("fresh").amountCents, sent[0].amountCents);
      assert.equal(orders.get("fresh").pricingSnapshot.displayCurrency, quote.pricing.displayCurrency);
      const discounted = (await request(app).post("/pricing/quote").send({packageId: 3, regionToken: catalog.regionToken, discountCode: " save10 "}).expect(200)).body;
      const discountedPayment = (await request(app).post("/payments/create-intent").send({orderId: "discounted", packageId: 3, quoteToken: discounted.quoteToken, discountCode: "SAVE10"}).expect(200)).body;
      assert.equal(discountedPayment.pricing.amountCents, discounted.pricing.amountCents);
      assert.equal(discounted.pricing.displayAmount, 4536);
      assert.equal(discounted.pricing.displayCurrency, "EGP");
    }
  } finally {globalThis.fetch = originalFetch; clearRateCache();}
});

test("missing, modified, expired and changed-price quotes cannot create an order or call Paymob", async () => {
  const {app, pkg, orders, sent} = setup();
  const quote = (await request(app).post("/pricing/quote").send({packageId: 3}).expect(200)).body;
  const body = {orderId: "unsafe", packageId: 3};
  await request(app).post("/payments/create-intent").send(body).expect(409);
  await request(app).post("/payments/create-intent").send({...body, quoteToken: quote.quoteToken + "x"}).expect(409);
  const expired = signPricingToken("checkout", readPricingToken(quote.quoteToken, "checkout"), -1);
  await request(app).post("/payments/create-intent").send({...body, quoteToken: expired}).expect(409);
  pkg.priceUSD += 1;
  const changed = await request(app).post("/payments/create-intent").send({...body, quoteToken: quote.quoteToken}).expect(409);
  assert.equal(changed.body.code, "PRICE_CHANGED");
  assert.equal(orders.size, 0); assert.equal(sent.length, 0);
});

test("changed, expired and invalid discounts cannot bypass the quote", async () => {
  const {app, discount, sent} = setup();
  await request(app).post("/pricing/quote").send({packageId: 3, discountCode: "NOPE"}).expect(400);
  const quote = (await request(app).post("/pricing/quote").send({packageId: 3, discountCode: "SAVE10"}).expect(200)).body;
  const body = {orderId: "discount", packageId: 3, quoteToken: quote.quoteToken};
  await request(app).post("/payments/create-intent").send(body).expect(409);
  discount.active = false;
  await request(app).post("/payments/create-intent").send({...body, discountCode: "SAVE10"}).expect(400);
  assert.equal(sent.length, 0);
});

test("existing and recovered orders return the stored amount, including legacy orders without a snapshot", async () => {
  const {app, orders, sent} = setup();
  orders.set("old", {id: "old", packageId: 3, userId: 1, amountCents: 380000, currency: "EGP", status: "pending"});
  const quote = (await request(app).post("/pricing/quote").send({packageId: 3}).expect(200)).body;
  const repeated = (await request(app).post("/payments/create-intent").send({orderId: "old", packageId: 3, quoteToken: quote.quoteToken}).expect(200)).body;
  const recovered = (await request(app).post("/payments/orders/old/retry-intent").expect(200)).body;
  assert.equal(repeated.pricing.amountCents, 380000);
  assert.equal(recovered.chargeAmountEGP, 3800);
  assert.ok(sent.every(p => p.amountCents === 380000 && p.currency === "EGP"));
  orders.get("old").userId = 2;
  await request(app).post("/payments/orders/old/retry-intent").expect(403);
});

test("unknown geography has the same Egypt fallback in production", async () => {
  const before = process.env.NODE_ENV;
  const allow = process.env.PAYMENT_ALLOW_CLIENT_REGION_HINT;
  process.env.NODE_ENV = "production";
  process.env.PAYMENT_ALLOW_CLIENT_REGION_HINT = "false";
  try {assert.equal((await resolvePaymentCountry({headers: {}, ip: "127.0.0.1"}, "US")).countryCode, "EG");}
  finally {process.env.NODE_ENV = before; if (allow == null) delete process.env.PAYMENT_ALLOW_CLIENT_REGION_HINT; else process.env.PAYMENT_ALLOW_CLIENT_REGION_HINT = allow;}
});
