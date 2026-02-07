import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { validateRequest } from "../../middleware/validateRequest.js";
import { logger } from "../../lib/logger.js";
import { audit } from "./shared.js";

const router = Router();
const UserIdParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

router.post("/admin/impersonate/stop", requireAuth, requireAdmin, async (req, res) => {
  try {
    const previousAsUserId = req.session?.asUserId || null;
    req.session.asUserId = null;

    await new Promise((resolve, reject) => {
      req.session.save((err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    if (previousAsUserId) {
      await audit(req.user.id, "impersonate_stop", "User", Number(previousAsUserId));
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "admin.stopImpersonate error");
    return res.status(500).json({ error: "Failed to stop impersonation" });
  }
});

router.post(
  "/admin/impersonate/:id",
  requireAuth,
  requireAdmin,
  validateRequest({ params: UserIdParamsSchema }),
  async (req, res) => {
    try {
      const targetId = req.params.id;

      if (targetId === req.user.id) {
        return res.status(400).json({ error: "Cannot impersonate yourself" });
      }

      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, isDisabled: true, email: true },
      });

      if (!target || target.isDisabled) {
        return res.status(404).json({ error: "User not found" });
      }

      const previousAsUserId = req.session?.asUserId || null;
      req.session.asUserId = targetId;

      await new Promise((resolve, reject) => {
        req.session.save((err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      await audit(req.user.id, "impersonate_start", "User", targetId, {
        previousAsUserId: previousAsUserId ? Number(previousAsUserId) : null,
      });

      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "admin.startImpersonate error");
      return res.status(500).json({ error: "Failed to start impersonation" });
    }
  }
);

export default router;
