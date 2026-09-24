// src/routes/sessions/_shared.js
// Common imports and helpers shared across all session route modules

import { Router } from "express";
import { prisma } from "../../lib/prisma.js";
import { requireAuth, requireAdmin } from "../../middleware/auth-helpers.js";
import {
    findSessionConflicts,
    findSessionConflictsWithClient,
    lockSchedulingResources,
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
import { audit } from "../admin/shared.js";

export {
    Router,
    prisma,
    requireAuth,
    requireAdmin,
    findSessionConflicts,
    findSessionConflictsWithClient,
    lockSchedulingResources,
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
