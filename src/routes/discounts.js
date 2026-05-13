import { Router } from "express";
import { prisma } from "../lib/prisma.js";
import {
  normalizeDiscountCode,
  validateDiscount,
} from "../services/paymentPricingService.js";

const router = Router();

router.post("/validate", async (req, res) => {
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
