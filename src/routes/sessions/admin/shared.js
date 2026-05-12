// src/routes/sessions/admin/shared.js
// Shared imports, constants, and helpers for admin session route modules

import {
  Router,
  prisma,
  requireAuth,
  requireAdmin,
  findSessionConflicts,
  getRemainingCredits,
  consumeOneCreditWithClient,
  consumeOneCredit,
  refundOneCredit,
  sendBookingNotifications,
  logger,
  audit,
} from "../_shared.js";

const ADMIN_SESSIONS_DEFAULT_LIMIT = 100;
const ADMIN_SESSIONS_MAX_LIMIT = 250;
const ADMIN_SESSIONS_MAX_OFFSET = 10000;

function parseBoundedInt(
  value,
  { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }
) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
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
  sendBookingNotifications,
  logger,
  audit,
  ADMIN_SESSIONS_DEFAULT_LIMIT,
  ADMIN_SESSIONS_MAX_LIMIT,
  ADMIN_SESSIONS_MAX_OFFSET,
  parseBoundedInt,
};
