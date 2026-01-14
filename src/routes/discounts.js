import { Router } from "express";
import prisma from "../prisma.js";

const router = Router();

router.post("/validate", async (req, res) => {
  const { code } = req.body;

  const discount = await prisma.discountCode.findFirst({
    where: {
      code: code.toUpperCase(),
      active: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });

  if (!discount) {
    return res.status(400).json({ error: "Invalid code" });
  }

  res.json({ percentage: discount.percentage });
});

export default router;
