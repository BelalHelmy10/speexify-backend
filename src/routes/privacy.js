import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth-helpers.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { logger } from "../lib/logger.js";
import {
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_TYPES,
  anonymizeUserForPrivacyDeletion,
  buildUserPrivacyExport,
  createPrivacyRequest,
  getPrivacyPolicySummary,
  getPrivacyRequestById,
  listPrivacyRequests,
  logPrivacyExportEvent,
  normalizePrivacyRequestStatus,
  updatePrivacyRequestStatus,
} from "../services/privacyService.js";

const router = Router();

const PrivacyRequestTypeSchema = z.enum([
  PRIVACY_REQUEST_TYPES.EXPORT,
  PRIVACY_REQUEST_TYPES.DELETE,
]);
const PrivacyRequestStatusSchema = z.enum([
  PRIVACY_REQUEST_STATUSES.PENDING,
  PRIVACY_REQUEST_STATUSES.IN_REVIEW,
  PRIVACY_REQUEST_STATUSES.COMPLETED,
  PRIVACY_REQUEST_STATUSES.REJECTED,
]);

const MeRequestsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const CreateMeRequestBodySchema = z
  .object({
    type: PrivacyRequestTypeSchema.optional().default(PRIVACY_REQUEST_TYPES.DELETE),
    reason: z.string().trim().max(2000).optional().default(""),
  })
  .strict();

const AdminRequestsQuerySchema = z.object({
  userId: z.coerce.number().int().positive().optional(),
  status: z.union([PrivacyRequestStatusSchema, z.literal("")]).optional().default(""),
  type: z.union([PrivacyRequestTypeSchema, z.literal("")]).optional().default(""),
  limit: z.coerce.number().int().min(1).max(200).optional().default(100),
});

const RequestIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const AdminPatchRequestBodySchema = z
  .object({
    status: PrivacyRequestStatusSchema,
    notes: z.string().trim().max(2000).optional().default(""),
  })
  .strict();

function isImpersonating(req) {
  return Boolean(req.session?.asUserId && req.user?.role === "admin");
}

router.get("/policy", (_req, res) => {
  return res.json(getPrivacyPolicySummary());
});

router.get(
  "/me/requests",
  requireAuth,
  validateRequest({ query: MeRequestsQuerySchema }),
  async (req, res) => {
    try {
      const items = await listPrivacyRequests({
        userId: req.viewUserId,
        limit: req.query.limit,
      });

      return res.json({ items });
    } catch (err) {
      logger.error({ err, userId: req.viewUserId }, "privacy.me.list failed");
      return res.status(500).json({ error: "Failed to load privacy requests" });
    }
  }
);

router.post(
  "/me/requests",
  requireAuth,
  validateRequest({ body: CreateMeRequestBodySchema }),
  async (req, res) => {
    try {
      const targetUser = await prisma.user.findUnique({
        where: { id: req.viewUserId },
        select: { id: true, email: true },
      });

      if (!targetUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const result = await createPrivacyRequest({
        userId: targetUser.id,
        userEmail: targetUser.email,
        type: req.body.type,
        reason: req.body.reason || null,
        requestedByAdminId: isImpersonating(req) ? req.user.id : null,
      });

      const statusCode = result.created ? 201 : 200;
      return res.status(statusCode).json(result);
    } catch (err) {
      logger.error({ err, userId: req.viewUserId }, "privacy.me.create failed");
      return res.status(500).json({ error: "Failed to create privacy request" });
    }
  }
);

router.get("/me/export", requireAuth, async (req, res) => {
  try {
    const payload = await buildUserPrivacyExport(req.viewUserId);

    await logPrivacyExportEvent({
      userId: req.viewUserId,
      userEmail: payload.user.email,
      requestedByAdminId: isImpersonating(req) ? req.user.id : null,
    });

    const ts = new Date().toISOString().replace(/[.:]/g, "-");
    res.setHeader("cache-control", "no-store");
    res.setHeader(
      "content-disposition",
      `attachment; filename=\"privacy-export-user-${req.viewUserId}-${ts}.json\"`
    );

    return res.json(payload);
  } catch (err) {
    if (err?.code === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "User not found" });
    }

    logger.error({ err, userId: req.viewUserId }, "privacy.me.export failed");
    return res.status(500).json({ error: "Failed to export user data" });
  }
});

router.get(
  "/admin/requests",
  requireAuth,
  requireAdmin,
  validateRequest({ query: AdminRequestsQuerySchema }),
  async (req, res) => {
    try {
      const items = await listPrivacyRequests({
        userId: req.query.userId ?? null,
        status: req.query.status,
        type: req.query.type,
        limit: req.query.limit,
      });

      return res.json({ items });
    } catch (err) {
      logger.error({ err, adminId: req.user?.id }, "privacy.admin.list failed");
      return res.status(500).json({ error: "Failed to load privacy requests" });
    }
  }
);

router.patch(
  "/admin/requests/:id",
  requireAuth,
  requireAdmin,
  validateRequest({
    params: RequestIdParamSchema,
    body: AdminPatchRequestBodySchema,
  }),
  async (req, res) => {
    try {
      const requestId = req.params.id;
      const nextStatus = normalizePrivacyRequestStatus(req.body.status);

      const current = await getPrivacyRequestById(requestId);
      if (!current) {
        return res.status(404).json({ error: "Privacy request not found" });
      }

      let deletionResult = null;
      const shouldExecuteDeletion =
        current.requestType === PRIVACY_REQUEST_TYPES.DELETE &&
        current.status !== PRIVACY_REQUEST_STATUSES.COMPLETED &&
        nextStatus === PRIVACY_REQUEST_STATUSES.COMPLETED;

      if (shouldExecuteDeletion) {
        deletionResult = await anonymizeUserForPrivacyDeletion({
          userId: current.userId,
        });
      }

      const updated = await updatePrivacyRequestStatus({
        requestId,
        status: nextStatus,
        notes: req.body.notes || null,
        processedByAdminId: req.user.id,
      });

      if (!updated) {
        return res.status(404).json({ error: "Privacy request not found" });
      }

      return res.json({ request: updated, deletionResult });
    } catch (err) {
      logger.error(
        { err, adminId: req.user?.id, requestId: req.params?.id },
        "privacy.admin.patch failed"
      );
      return res.status(500).json({ error: "Failed to update privacy request" });
    }
  }
);

export default router;
