import crypto from "node:crypto";
import { prisma } from "../../lib/prisma.js";
import { logger } from "../../lib/logger.js";
import {
  ADMIN_ALERT_TYPES,
  notifyAdmins,
} from "../../services/adminAlertsService.js";

const SECURITY_AUDIT_ACTIONS = new Set([
  "role_change",
  "user_disable",
  "user_enable",
  "impersonate_start",
  "password_reset_send",
  "teacher_rate_update",
  "teacher_payout_created",
  "teacher_payout_void",
  "teacher_payout_reverse",
  "teacher_earning_adjustment_created",
]);

function auditAlertCopy(action) {
  return ({
    role_change: ["User role changed", "critical"],
    user_disable: ["User account disabled", "warning"],
    user_enable: ["User account re-enabled", "info"],
    impersonate_start: ["Admin impersonation started", "critical"],
    password_reset_send: ["Admin sent a password reset", "warning"],
    teacher_rate_update: ["Teacher compensation rate changed", "warning"],
    teacher_payout_created: ["Teacher payout recorded", "warning"],
    teacher_payout_void: ["Teacher payout voided", "critical"],
    teacher_payout_reverse: ["Teacher payout reversed", "critical"],
    teacher_earning_adjustment_created: ["Teacher earnings adjusted", "warning"],
  })[action] || ["Sensitive admin action", "warning"];
}

export const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

export const hashCode = (raw) =>
  crypto.createHash("sha256").update(String(raw)).digest("hex");

export async function audit(actorId, action, entity, entityId, meta = {}) {
  try {
    const row = await prisma.audit.create({
      data: { actorId, action, entity, entityId, meta },
    });
    if (SECURITY_AUDIT_ACTIONS.has(action)) {
      const [actor, target] = await Promise.all([
        prisma.user.findUnique({
          where: { id: Number(actorId) },
          select: { id: true, name: true, email: true },
        }),
        entity === "User" && entityId
          ? prisma.user.findUnique({
              where: { id: Number(entityId) },
              select: { id: true, name: true, email: true, role: true },
            })
          : null,
      ]);
      const [title, severity] = auditAlertCopy(action);
      const actorLabel = actor?.name || actor?.email || `Admin #${actorId}`;
      const targetLabel = target?.name || target?.email || `${entity} #${entityId || "unknown"}`;
      await notifyAdmins({
        type: action.startsWith("teacher_")
          ? ADMIN_ALERT_TYPES.PAYROLL
          : ADMIN_ALERT_TYPES.SECURITY,
        title,
        body: `${actorLabel} performed ${action.replaceAll("_", " ")} on ${targetLabel}.`,
        severity,
        adminPath: entity === "User" && entityId
          ? `/admin/registrations/${entityId}`
          : "/admin?section=teacher-earnings",
        data: { auditId: row?.id || null, actorId, action, entity, entityId, meta },
        dedupeKey: row?.id
          ? `audit:${row.id}`
          : `audit:${actorId}:${action}:${entity}:${entityId || "unknown"}:${Date.now()}`,
        dedupeWindowMs: null,
        email: severity === "critical" ? "critical" : "none",
        mandatory: severity === "critical",
        excludeAdminIds: [actorId],
      });
    }
  } catch (err) {
    logger.error({ err }, "admin audit failed");
  }
}
