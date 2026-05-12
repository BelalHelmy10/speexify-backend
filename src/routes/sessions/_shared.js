// src/routes/sessions/_shared.js
// Common imports and helpers shared across all session route modules

import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import {
    findSessionConflicts,
    getRemainingCredits,
    consumeOneCreditWithClient,
    consumeOneCredit,
    refundOneCredit,
    finalizeExpiredSessionsForUser,
    finalizeExpiredSessionsForTeacher,
} from "../../services/sessionsService.js";
import {
    createNotification,
    sendBookingNotifications,
    sendCancellationNotifications,
    sendFeedbackNotifications,
} from "../../services/notificationsService.js";
import { logger } from "../../lib/logger.js";

// Simple audit stub to avoid ReferenceError and keep logs
async function audit(userId, action, entity, entityId, meta = {}) {
    logger.info({ userId, action, entity, entityId, meta }, "audit event");
}

export {
    Router,
    prisma,
    requireAuth,
    requireAdmin,
    findSessionConflicts,
    getRemainingCredits,
    consumeOneCreditWithClient,
    consumeOneCredit,
    refundOneCredit,
    finalizeExpiredSessionsForUser,
    finalizeExpiredSessionsForTeacher,
    createNotification,
    sendBookingNotifications,
    sendCancellationNotifications,
    sendFeedbackNotifications,
    logger,
    audit,
};
