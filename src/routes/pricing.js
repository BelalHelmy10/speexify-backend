import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { buildDisplayPrice, buildPaymentQuote, normalizeDiscountCode, resolvePaymentCountry, validateDiscount } from "../services/paymentPricingService.js";
import { packagePriceVersion, pricingError, publicQuote, readPricingToken, signPricingToken } from "../services/pricingQuoteService.js";

const QuoteBody = z.object({
  packageId: z.coerce.number().int().positive(),
  regionToken: z.string().max(3000).optional().nullable(),
  discountCode: z.string().trim().max(64).optional().nullable(),
}).strict();

export function createPricingRouter({db = prisma, resolveCountry = resolvePaymentCountry, buildQuote = buildPaymentQuote} = {}) {
  const router = Router();
  router.use(rateLimit({windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false}));
  router.use((_req, res, next) => {res.set("Cache-Control", "private, no-store"); next();});
  router.get("/catalog", async (req, res) => {
    try {
      const region = await resolveCountry(req);
      const packages = await db.package.findMany({where: {active: true, deletedAt: null, priceType: {not: "CUSTOM"}}, orderBy: {sortOrder: "asc"}});
      const items = packages.map(pkg => ({
        id: pkg.id, catalogKey: pkg.catalogKey, title: pkg.title, description: pkg.description,
        durationMin: pkg.durationMin, sessionsPerPack: pkg.sessionsPerPack,
        priceType: pkg.priceType, priceEGP: pkg.priceUSD, image: pkg.image,
        pricing: buildDisplayPrice(pkg, region.countryCode),
      }));
      res.json({countryCode: region.countryCode, countrySource: region.source,
        regionToken: signPricingToken("region", region, 60 * 60 * 1000), packages: items});
    } catch (error) {
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
