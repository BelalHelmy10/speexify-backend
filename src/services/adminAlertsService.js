import { prisma } from "../lib/prisma.js";
import { logger } from "../lib/logger.js";
import { createNotification } from "./notificationsService.js";
import { enqueueEmail } from "./emailService.js";

export const ADMIN_ALERT_TYPES = Object.freeze({
  PAYMENT_SUCCEEDED: "admin_payment_succeeded",
  PAYMENT_ATTENTION: "admin_payment_attention",
  SESSION_ACTIVITY: "admin_session_activity",
  SESSION_ATTENTION: "admin_session_attention",
  CREDIT_ATTENTION: "admin_credit_attention",
  SUPPORT_TICKET: "admin_support_ticket",
  SUPPORT_REPLY: "admin_support_reply",
  SUPPORT_SLA: "admin_support_sla",
  INTAKE_SUBMITTED: "admin_intake_submitted",
  ASSESSMENT_SUBMITTED: "admin_assessment_submitted",
  RECORDING_READY: "admin_recording_ready",
  RECORDING_FAILED: "admin_recording_failed",
  SECURITY: "admin_security_alert",
  PAYROLL: "admin_payroll_alert",
  SYSTEM: "admin_system_alert",
  DAILY_DIGEST: "admin_daily_digest",
  LEAD: "admin_lead",
});

const DEFAULT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEVERITIES = new Set(["info", "success", "warning", "critical"]);

function normalizeSeverity(value) {
  const normalized = String(value || "info").toLowerCase();
  return SEVERITIES.has(normalized) ? normalized : "info";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function adminBaseUrl() {
  return String(
    process.env.ADMIN_APP_URL || process.env.FRONTEND_URL || "https://speexify.com"
  ).replace(/\/$/, "");
}

function safeAdminPath(value) {
  const path = String(value || "").trim();
  if (!path.startsWith("/") || path.startsWith("//")) return "/admin";
  return path;
}

function buildAlertEmail({ title, body, severity, adminPath }) {
  const path = safeAdminPath(adminPath);
  const actionUrl = `${adminBaseUrl()}${path}`;
  const tone = severity === "critical"
    ? { bg: "#fff1f2", fg: "#be123c", label: "Critical" }
    : severity === "warning"
      ? { bg: "#fff7ed", fg: "#c2410c", label: "Warning" }
      : severity === "success"
        ? { bg: "#ecfdf5", fg: "#047857", label: "Success" }
        : { bg: "#eff6ff", fg: "#1d4ed8", label: "Information" };

  return `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#172033;line-height:1.6">
      <div style="background:${tone.bg};border-radius:16px;padding:22px 24px;margin-bottom:20px">
        <div style="font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:${tone.fg}">Speexify admin · ${tone.label}</div>
        <h2 style="margin:8px 0 0;font-size:24px">${escapeHtml(title)}</h2>
      </div>
      ${body ? `<p style="font-size:16px">${escapeHtml(body)}</p>` : ""}
      <p><a href="${escapeHtml(actionUrl)}" style="display:inline-block;background:#172033;color:white;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">Open in admin</a></p>
      <p style="color:#64748b;font-size:13px;margin-top:24px">This is a durable operational alert from Speexify.</p>
    </div>
  `;
}

function getAdminPreferences(admin) {
  return {
    adminInAppOperationalAlerts: true,
    adminEmailCriticalAlerts: true,
    adminDailyDigest: true,
    ...(admin?.notificationPreferences || {}),
  };
}

function deliveryEventType(type, dedupeKey) {
  return dedupeKey ? `admin:${type}:${String(dedupeKey)}` : String(type);
}

async function findDuplicate(adminId, type, dedupeKey, dedupeWindowMs) {
  if (!dedupeKey) return null;
  const createdAt = dedupeWindowMs === null
    ? undefined
    : { gte: new Date(Date.now() - Math.max(1, Number(dedupeWindowMs) || DEFAULT_DEDUPE_WINDOW_MS)) };

  const [notification, delivery] = await Promise.all([
    prisma.notification.findFirst({
      where: {
        userId: adminId,
        type,
        ...(createdAt ? { createdAt } : {}),
        data: { path: ["adminAlertKey"], equals: String(dedupeKey) },
      },
      orderBy: { id: "desc" },
      select: { id: true },
    }),
    prisma.notificationDelivery.findFirst({
      where: {
        userId: adminId,
        eventType: deliveryEventType(type, dedupeKey),
        ...(createdAt ? { createdAt } : {}),
      },
      orderBy: { id: "desc" },
      select: { id: true },
    }),
  ]);
  return { notification, delivery };
}

/**
 * Persist an operational alert for active admins and optionally enqueue a
 * durable email. This function deliberately isolates each recipient so an
 * alert failure can never roll back the business action that triggered it.
 */
export async function notifyAdmins({
  type = ADMIN_ALERT_TYPES.SYSTEM,
  title,
  body = null,
  severity = "info",
  data = {},
  adminPath = "/admin",
  dedupeKey = null,
  dedupeWindowMs = DEFAULT_DEDUPE_WINDOW_MS,
  email = "none", // none | critical | always
  mandatory = false,
  targetAdminIds = null,
  excludeAdminIds = [],
} = {}) {
  if (process.env.NODE_ENV === "test") {
    return { admins: 0, notifications: 0, emails: 0, skipped: 0, failed: 0 };
  }
  if (!title) return { admins: 0, notifications: 0, emails: 0, skipped: 0 };

  const normalizedSeverity = normalizeSeverity(severity);
  const excluded = new Set((excludeAdminIds || []).map(Number));
  const targets = Array.isArray(targetAdminIds)
    ? [...new Set(targetAdminIds.map(Number).filter(Number.isFinite))]
    : null;

  try {
    const admins = await prisma.user.findMany({
      where: {
        role: "admin",
        isDisabled: false,
        ...(targets ? { id: { in: targets } } : {}),
        ...(excluded.size ? { NOT: { id: { in: [...excluded] } } } : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        notificationPreferences: true,
      },
    });

    const results = await Promise.allSettled(admins.map(async (admin) => {
      const preferences = getAdminPreferences(admin);
      if (type === ADMIN_ALERT_TYPES.DAILY_DIGEST && preferences.adminDailyDigest === false) {
        return { skipped: true, notification: null, emailed: false };
      }
      const shouldCreateInApp = mandatory || normalizedSeverity === "critical" || preferences.adminInAppOperationalAlerts !== false;
      const shouldEmail = email === "always" || (
        email === "critical" &&
        (mandatory || preferences.adminEmailCriticalAlerts !== false)
      );
      const duplicate = await findDuplicate(admin.id, type, dedupeKey, dedupeWindowMs);
      let notification = duplicate?.notification || null;
      let emailed = Boolean(duplicate?.delivery);
      let createdNotification = false;
      let queuedEmail = false;
      if (shouldCreateInApp && !notification) {
        notification = await createNotification({
          userId: admin.id,
          type,
          title,
          body,
          data: {
            ...data,
            severity: normalizedSeverity,
            adminPath: safeAdminPath(adminPath),
            ...(dedupeKey ? { adminAlertKey: String(dedupeKey) } : {}),
          },
          skipPreferenceCheck: true,
          skipDedup: true,
        });
        createdNotification = Boolean(notification);
      }

      if (shouldEmail && admin.email && !emailed) {
        await enqueueEmail(
          admin.email,
          `[Speexify ${normalizedSeverity}] ${title}`,
          buildAlertEmail({ title, body, severity: normalizedSeverity, adminPath }),
          {
            userId: admin.id,
            notificationId: notification?.id || null,
            eventType: deliveryEventType(type, dedupeKey),
            locale: "en",
          }
        );
        emailed = true;
        queuedEmail = true;
      }

      return {
        skipped: !createdNotification && !queuedEmail,
        notification,
        createdNotification,
        emailed,
        queuedEmail,
      };
    }));

    const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.error(
          { err: result.reason, adminId: admins[index]?.id, type, dedupeKey },
          "admin alert delivery failed"
        );
      }
    });

    return {
      admins: admins.length,
      notifications: fulfilled.filter((result) => result.createdNotification).length,
      emails: fulfilled.filter((result) => result.queuedEmail).length,
      skipped: fulfilled.filter((result) => result.skipped).length,
      failed: results.filter((result) => result.status === "rejected").length,
    };
  } catch (error) {
    logger.error({ err: error, type, dedupeKey }, "failed to prepare admin alert");
    return { admins: 0, notifications: 0, emails: 0, skipped: 0, failed: 1 };
  }
}

export function notifyAdminsSafely(options) {
  void notifyAdmins(options).catch((error) => {
    logger.error({ err: error, type: options?.type }, "async admin alert failed");
  });
}
