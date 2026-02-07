import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { logger } from "../../lib/logger.js";

const router = Router();

router.get("/admin/users/:id/packages", requireAuth, requireAdmin, async (req, res) => {
  try {
    const userId = Number(req.params.id);
    if (Number.isNaN(userId)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const packages = await prisma.userPackage.findMany({
      where: { userId },
      include: {
        package: {
          select: {
            title: true,
            priceUSD: true,
            sessionsPerPack: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const enhanced = packages.map((p) => ({
      ...p,
      remaining: (p.sessionsTotal || 0) - (p.sessionsUsed || 0),
      packageTitle: p.package?.title || "Custom/Unknown Package",
      packagePriceUSD: p.package?.priceUSD || null,
    }));

    res.json(enhanced);
  } catch (err) {
    logger.error({ err }, "admin.userPackages error");
    res.status(500).json({ error: "Failed to load user packages" });
  }
});

export default router;
