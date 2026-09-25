import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { buildDisplayPrice, buildPaymentQuote, normalizeDiscountCode, resolvePaymentCountry, validateDiscount } from "../services/paymentPricingService.js";
import { packagePriceVersion, pricingError, publicQuote, readPricingToken, signPricingToken } from "../services/pricingQuoteService.js";
import { recordBusinessMetric } from "../observability/metrics.js";

const QuoteBody = z.object({
  packageId: z.coerce.number().int().positive(),
  regionToken: z.string().max(3000).optional().nullable(),
  discountCode: z.string().trim().max(64).optional().nullable(),
}).strict();

let clearDefaultPricingCatalogCacheImpl = () => {};

export function clearDefaultPricingCatalogCache() {
  clearDefaultPricingCatalogCacheImpl();
}

export function createPricingRouter({db = prisma, resolveCountry = resolvePaymentCountry, buildQuote = buildPaymentQuote} = {}) {
  const router = Router();
  // The catalog is public and changes infrequently, but the request still
  // needs the current region token. Cache the database-backed package list
  // per router/country for a short period so a slow database round-trip does
  // not block every visitor. The cache is local to the router instance, which
  // keeps injected test databases isolated.
  const catalogCache = new Map();
  const catalogCacheTtlMs = Math.max(
    5_000,
    Number(process.env.PRICING_CATALOG_CACHE_TTL_MS) || 30_000,
  );
  if (db === prisma) {
    clearDefaultPricingCatalogCacheImpl = () => catalogCache.clear();
  }
  router.use(rateLimit({windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false}));
  router.use((_req, res, next) => {res.set("Cache-Control", "private, no-store"); next();});
  router.get("/catalog", async (req, res) => {
    const startedAt = Date.now();
    recordBusinessMetric("pricingCatalog", "requests");
    try {
      const region = await resolveCountry(req);
      const cacheKey = region.countryCode || "EG";
      const cached = catalogCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        res.json(cached.payload);
        recordBusinessMetric("pricingCatalog", "successes", {durationMs: Date.now() - startedAt});
        return;
      }

      const packages = await db.package.findMany({
        where: {active: true, deletedAt: null, priceType: {not: "CUSTOM"}},
        orderBy: {sortOrder: "asc"},
        select: {
          id: true, catalogKey: true, title: true, description: true,
          durationMin: true, sessionsPerPack: true, priceType: true,
          priceUSD: true, image: true, pricingOverrides: true,
          active: true, deletedAt: true,
        },
      });
      const items = packages.map(pkg => ({
        id: pkg.id, catalogKey: pkg.catalogKey, title: pkg.title, description: pkg.description,
        durationMin: pkg.durationMin, sessionsPerPack: pkg.sessionsPerPack,
        priceType: pkg.priceType, priceEGP: pkg.priceUSD, image: pkg.image,
        pricing: buildDisplayPrice(pkg, region.countryCode),
      }));
      const payload = {countryCode: region.countryCode, countrySource: region.source,
        regionToken: signPricingToken("region", region, 60 * 60 * 1000), packages: items};
      catalogCache.set(cacheKey, {expiresAt: Date.now() + catalogCacheTtlMs, payload});
      res.json(payload);
      recordBusinessMetric("pricingCatalog", "successes", {durationMs: Date.now() - startedAt});
    } catch (error) {
      recordBusinessMetric("pricingCatalog", "failures", {durationMs: Date.now() - startedAt});
      res.status(error.status || 503).json({code: error.code || "PRICING_UNAVAILABLE", message: "Prices are temporarily unavailable. Please try again."});
    }
  });
  router.post("/quote", validateRequest({body: QuoteBody}), async (req, res) => {
    try {
      const {packageId, regionToken} = req.body;
      const pkg = await db.package.findUnique({where: {id: packageId}});
      const discountCode = normalizeDiscountCode(req.body.discountCode);
      const discount = discountCode ? validateDiscount(await db.discountCode.findUnique({where: {code: discountCode}})) : null;
      if (discountCode && !discount) throw pricingError("INVALID_DISCOUNT", "Discount code is invalid or no longer available.", 400);
      const region = regionToken ? readPricingToken(regionToken, "region") : await resolveCountry(req);
      const quote = await buildQuote({pkg, discount, countryCode: region.countryCode});
      const pricing = publicQuote(quote);
      res.json({ok: true, pricing, quoteToken: signPricingToken("checkout", {
        packageVersion: packagePriceVersion(pkg), discountCode, discountId: discount?.id || null, pricing,
      })});
    } catch (error) {
      res.status(error.status || 503).json({ok: false, code: error.code || "PRICING_UNAVAILABLE", message: error.status ? error.message : "We could not confirm the price. Please try again."});
    }
  });
  return router;
}
export default createPricingRouter();
