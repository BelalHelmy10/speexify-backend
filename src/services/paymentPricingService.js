// src/services/paymentPricingService.js
import { logger } from "../lib/logger.js";
import { convertToEGP } from "./currencyService.js";

const PRICING_REGIONS = {
  EG: {
    currency: "EGP",
    multiplier: 1,
    name: "Egypt",
  },
  US: {
    currency: "USD",
    multiplier: 0.375,
    name: "United States",
  },
  GB: {
    currency: "GBP",
    multiplier: 0.25,
    name: "United Kingdom",
  },
  AE: {
    currency: "AED",
    multiplier: 0.25,
    name: "United Arab Emirates",
  },
  SA: {
    currency: "SAR",
    multiplier: 0.25,
    name: "Saudi Arabia",
  },
  DEFAULT: {
    currency: "USD",
    multiplier: 0.25,
    name: "International",
  },
};

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
];

const geoCountryCache = new Map();
const GEO_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const GEO_LOOKUP_TIMEOUT_MS = 1500;

export function normalizeCountryCode(raw) {
  const code = String(raw || "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export function normalizeDiscountCode(raw) {
  const code = String(raw || "")
    .trim()
    .toUpperCase();
  return code || null;
}

export function getPricingRegion(countryCode) {
  const code = normalizeCountryCode(countryCode);
  return code ? (PRICING_REGIONS[code] || PRICING_REGIONS.DEFAULT) : PRICING_REGIONS.EG;
}

export function getTrustedCountryFromHeaders(req) {
  const headers = req?.headers || {};
  const candidates = [
    headers["cf-ipcountry"],
    headers["x-vercel-ip-country"],
    headers["cloudfront-viewer-country"],
    headers["x-appengine-country"],
  ];

  for (const candidate of candidates) {
    const code = normalizeCountryCode(Array.isArray(candidate) ? candidate[0] : candidate);
    if (code && code !== "XX") return code;
  }

  return null;
}

function extractClientIp(req) {
  const raw =
    req?.headers?.["cf-connecting-ip"] ||
    req?.headers?.["x-real-ip"] ||
    req?.headers?.["x-forwarded-for"] ||
    req?.ip ||
    req?.socket?.remoteAddress ||
    "";

  const first = String(Array.isArray(raw) ? raw[0] : raw)
    .split(",")[0]
    .trim()
    .replace(/^::ffff:/, "");

  if (!first || first === "::1") return null;
  if (PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(first))) return null;
  return first;
}

async function lookupCountryByIp(ip) {
  if (!ip || typeof fetch !== "function") return null;

  const cached = geoCountryCache.get(ip);
  if (cached && Date.now() - cached.timestamp < GEO_CACHE_TTL_MS) {
    return cached.countryCode;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const data = await response.json();
    const countryCode = normalizeCountryCode(data?.country || data?.country_code);

    if (countryCode) {
      geoCountryCache.set(ip, { countryCode, timestamp: Date.now() });
      return countryCode;
    }
  } catch (error) {
    logger.debug({ err: error, ip }, "Payment geo lookup failed");
  } finally {
    clearTimeout(timer);
  }

  return null;
}

export async function resolvePaymentCountry(req, countryCodeHint) {
  const headerCountry = getTrustedCountryFromHeaders(req);
  if (headerCountry) {
    return { countryCode: headerCountry, source: "trusted_header" };
  }

  const ipCountry = await lookupCountryByIp(extractClientIp(req));
  if (ipCountry) {
    return { countryCode: ipCountry, source: "ip_lookup" };
  }

  const hint = normalizeCountryCode(countryCodeHint);
  const canUseClientHint =
    process.env.NODE_ENV !== "production" ||
    process.env.PAYMENT_ALLOW_CLIENT_REGION_HINT === "true";

  if (hint && canUseClientHint) {
    return { countryCode: hint, source: "client_hint" };
  }

  return { countryCode: "EG", source: "default" };
}

export function validateDiscount(discount) {
  if (!discount || !discount.active) return null;
  if (discount.expiresAt && discount.expiresAt <= new Date()) return null;
  if (
    discount.maxUses != null &&
    Number(discount.usedCount || 0) >= Number(discount.maxUses)
  ) {
    return null;
  }

  const percentage = Number(discount.percentage || 0);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    return null;
  }

  return { ...discount, percentage };
}

function packageBaseAmountEGP(pkg) {
  // Historical schema name is priceUSD, but the app treats it as the base EGP
  // package amount for regional pricing.
  const base = Number(pkg?.priceEGP ?? pkg?.priceUSD ?? 0);
  return Number.isFinite(base) ? base : 0;
}

function applyDiscount(amount, percentage) {
  if (!percentage) return Math.round(amount);
  return Math.round(amount * (1 - Number(percentage) / 100));
}

export async function buildPaymentQuote({ pkg, discount, countryCode }) {
  if (!pkg || !pkg.active || pkg.deletedAt) {
    const error = new Error("Package is not available for purchase");
    error.status = 400;
    error.code = "PACKAGE_UNAVAILABLE";
    throw error;
  }

  if (String(pkg.priceType || "").toUpperCase() === "CUSTOM") {
    const error = new Error("This package requires manual pricing");
    error.status = 400;
    error.code = "CUSTOM_PACKAGE";
    throw error;
  }

  const baseAmountEGP = packageBaseAmountEGP(pkg);
  if (baseAmountEGP <= 0) {
    const error = new Error("Package price is missing");
    error.status = 400;
    error.code = "PACKAGE_PRICE_MISSING";
    throw error;
  }

  const validDiscount = validateDiscount(discount);
  const discountPercentage = validDiscount?.percentage || 0;
  const discountedBaseEGP = applyDiscount(baseAmountEGP, discountPercentage);

  if (discountedBaseEGP <= 0) {
    const error = new Error("Discount makes this checkout amount zero");
    error.status = 400;
    error.code = "ZERO_AMOUNT_CHECKOUT";
    throw error;
  }

  const { displayAmount, displayCurrency, regionName } = buildDisplayPrice(pkg, countryCode, discountPercentage);

  const conversion =
    displayCurrency === "EGP"
      ? { egpAmount: displayAmount, rate: 1 }
      : await convertToEGP(displayAmount, displayCurrency);

  const egpAmountCents = Math.round(Number(conversion.egpAmount) * 100);
  const displayAmountCents = Math.round(displayAmount * 100);

  if (!Number.isInteger(egpAmountCents) || egpAmountCents <= 0) {
    const error = new Error("Calculated EGP payment amount is invalid");
    error.status = 400;
    error.code = "INVALID_EGP_PAYMENT_AMOUNT";
    throw error;
  }

  return {
    packageId: pkg.id,
    baseAmountEGP,
    discountCodeId: validDiscount?.id || null,
    discountPercentage,
    countryCode: normalizeCountryCode(countryCode) || "EG",
    regionName,
    displayAmount,
    displayAmountCents,
    displayCurrency,
    egpAmountCents,
    egpCurrency: "EGP",
    exchangeRate: conversion.rate,
  };
}

// Regional offers are selling prices. Convert their value to EGP only on the
// server, when a checkout quote is issued; never substitute the Egypt base.
export function buildDisplayPrice(pkg, countryCode, discountPercentage = 0) {
  const code = normalizeCountryCode(countryCode) || "EG";
  const region = getPricingRegion(code);
  const override = pkg.pricingOverrides?.[code];
  const base = packageBaseAmountEGP(pkg);
  if (!pkg.active || pkg.deletedAt || pkg.priceType === "CUSTOM" || base <= 0) {
    throw Object.assign(new Error("Package is not available for purchase"), {status: 400, code: "PACKAGE_UNAVAILABLE"});
  }
  if (override && (override.currency !== region.currency || !Number.isFinite(override.total) || override.total <= 0)) {
    throw Object.assign(new Error("Invalid regional package price"), {status: 400, code: "INVALID_REGIONAL_PRICE"});
  }
  const displayAmount = override
    ? Math.round(override.total * (1 - discountPercentage / 100))
    : Math.round(applyDiscount(base, discountPercentage) * region.multiplier);
  if (!Number.isSafeInteger(displayAmount) || displayAmount <= 0 || displayAmount * 100 > 2147483647) {
    throw Object.assign(new Error("Invalid package amount"), {status: 400, code: "INVALID_PAYMENT_AMOUNT"});
  }
  return {displayAmount, displayCurrency: region.currency, countryCode: code, regionName: region.name};
}
