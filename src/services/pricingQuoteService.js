import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { SESSION_SECRET } from "../config/env.js";

export const QUOTE_TTL_MS = 15 * 60 * 1000;
export function pricingError(code, message, status = 409) {
  return Object.assign(new Error(message), { code, status });
}
export function signPricingToken(kind, value, ttl = QUOTE_TTL_MS) {
  const payload = Buffer.from(JSON.stringify({kind, value, expiresAt: Date.now() + ttl})).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET).update(`pricing-v1:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}
export function readPricingToken(token, kind) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 2) throw new Error();
    const expected = createHmac("sha256", SESSION_SECRET).update(`pricing-v1:${parts[0]}`).digest();
    const received = Buffer.from(parts[1], "base64url");
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error();
    const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    if (payload.kind !== kind || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= Date.now()) throw new Error();
    return payload.value;
  } catch {
    throw pricingError("QUOTE_EXPIRED", "This price has expired. Refresh the price before continuing.");
  }
}
export function packagePriceVersion(pkg) {
  return createHash("sha256").update(JSON.stringify([
    pkg.id, pkg.priceEGP ?? pkg.priceUSD, pkg.pricingOverrides ?? null,
    pkg.active, pkg.deletedAt ?? null, pkg.priceType, pkg.sessionsPerPack, pkg.durationMin,
  ])).digest("hex");
}
export function publicQuote(quote) {
  const amountCents = quote.egpAmountCents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0 || amountCents > 2147483647) {
    throw pricingError("INVALID_PAYMENT_AMOUNT", "Invalid payment amount", 400);
  }
  return {
    packageId: quote.packageId, countryCode: quote.countryCode,
    displayAmount: quote.displayAmount, displayAmountCents: quote.displayAmountCents,
    displayCurrency: quote.displayCurrency, amountCents, currency: "EGP",
    egpAmount: amountCents / 100, discountPercentage: quote.discountPercentage,
    exchangeRate: quote.exchangeRate,
  };
}
export function orderPricing(order) {
  const amountCents = Number(order.amountCents);
  if (order.currency !== "EGP" || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw pricingError("INVALID_PAYMENT_AMOUNT", "This order cannot be resumed online.");
  }
  return {...(order.pricingSnapshot || {}), packageId: order.packageId,
    amountCents, currency: "EGP", egpAmount: amountCents / 100};
}
export function paymentResponse(order, intention) {
  const pricing = orderPricing(order);
  return {ok: true, orderId: order.id, iframeUrl: intention.checkoutUrl,
    intentionId: intention.intentionId, pricing,
    // Compatibility for older frontends during a rolling deployment.
    chargeAmountEGP: pricing.egpAmount, chargeCurrency: "EGP"};
}
export function verifyQuoteForPurchase(token, pkg, discount, discountCode) {
  const signed = readPricingToken(token, "checkout");
  if (signed.packageVersion !== packagePriceVersion(pkg) || signed.pricing.packageId !== pkg.id ||
      signed.discountCode !== (discountCode || null) ||
      signed.discountId !== (discount?.id || null) ||
      signed.pricing.discountPercentage !== (discount?.percentage || 0)) {
    throw pricingError("PRICE_CHANGED", "The package or discount has changed. Review a fresh price before paying.");
  }
  return signed.pricing;
}
