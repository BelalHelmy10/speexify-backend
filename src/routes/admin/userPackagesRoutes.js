import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { validateRequest } from "../../middleware/validateRequest.js";
import { logger } from "../../lib/logger.js";

const router = Router();
const UserIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

router.get(
  "/admin/users/:id/packages",
  requireAuth,
  requireAdmin,
  validateRequest({ params: UserIdParamsSchema }),
  async (req, res) => {
    try {
      const userId = Number(req.params.id);

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

      const now = new Date();
      const enhanced = packages.map((p) => ({
        ...p,
        remaining: Math.max(
          0,
          Number(p.sessionsTotal || 0) - Number(p.sessionsUsed || 0)
        ),
        expired: Boolean(p.expiresAt && new Date(p.expiresAt) <= now),
        creditEligible:
          p.status === "active" &&
          (!p.expiresAt || new Date(p.expiresAt) > now) &&
          Number(p.sessionsTotal || 0) > Number(p.sessionsUsed || 0),
        packageTitle: p.package?.title || "Custom/Unknown Package",
        packagePriceUSD: p.package?.priceUSD || null,
      }));

      res.json(enhanced);
    } catch (err) {
      logger.error({ err }, "admin.userPackages error");
      res.status(500).json({ error: "Failed to load user packages" });
    }
  }
);

export default router;
