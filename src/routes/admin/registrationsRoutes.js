import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import { validateRequest } from "../../middleware/validateRequest.js";

const router = Router();

const RegistrationParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

router.get(
  "/admin/registrations/:id",
  requireAuth,
  requireAdmin,
  validateRequest({ params: RegistrationParamsSchema }),
  async (req, res, next) => {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.params.id },
        select: {
          id: true,
          email: true,
          name: true,
          avatarUrl: true,
          role: true,
          phone: true,
          timezone: true,
          language: true,
          isDisabled: true,
          createdAt: true,
          updatedAt: true,
          passwordChangedAt: true,
          marketingPhoneConsentAt: true,
          marketingPhoneConsentSource: true,
          marketingPhoneConsentVersion: true,
          marketingPhoneOptOutAt: true,
          _count: {
            select: {
              orders: true,
              userPackages: true,
              sessions: true,
              sessionParticipants: true,
              onboardingForms: true,
              assessmentSubmissions: true,
            },
          },
          orders: {
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              amountCents: true,
              currency: true,
              status: true,
              psp: true,
              pspOrderId: true,
              paymobTxnId: true,
              customerEmail: true,
              customerPhone: true,
              createdAt: true,
              updatedAt: true,
              package: { select: { id: true, title: true } },
            },
          },
          userPackages: {
            orderBy: { createdAt: "desc" },
            take: 50,
            select: {
              id: true,
              title: true,
              minutesPerSession: true,
              sessionsTotal: true,
              sessionsUsed: true,
              expiresAt: true,
              status: true,
              createdAt: true,
              updatedAt: true,
              package: { select: { id: true, title: true } },
              order: {
                select: {
                  id: true,
                  status: true,
                  amountCents: true,
                  currency: true,
                },
              },
            },
          },
          onboardingForms: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              id: true,
              packageId: true,
              answers: true,
              status: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          assessmentSubmissions: {
            orderBy: { createdAt: "desc" },
            take: 10,
            select: {
              id: true,
              packageId: true,
              text: true,
              wordCount: true,
              status: true,
              score: true,
              cefr: true,
              feedback: true,
              reviewedAt: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      });

      if (!user) return res.status(404).json({ error: "User not found" });
      return res.json({ user });
    } catch (err) {
      return next(err);
    }
  }
);

export default router;
