import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { validateRequest } from "../middleware/validateRequest.js";
import {
  normalizeDiscountCode,
  validateDiscount,
} from "../services/paymentPricingService.js";

const router = Router();

const DiscountValidateBodySchema = z
  .object({
    code: z.string().trim().min(1).max(64),
  })
  .strict();

router.post("/validate", validateRequest({ body: DiscountValidateBodySchema }), async (req, res) => {
  const code = normalizeDiscountCode(req.body?.code);

  if (!code) {
    return res.status(400).json({ error: "Invalid code" });
  }

  const discount = await prisma.discountCode.findUnique({
    where: { code },
  });

  const validDiscount = validateDiscount(discount);

  if (!validDiscount) {
    return res.status(400).json({ error: "Invalid code" });
  }

  res.json({ percentage: validDiscount.percentage });
});

export default router;
